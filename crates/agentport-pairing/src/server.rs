use crate::{
    authorize, now, random_id, Invitation, PairingReply, PairingRequest, Result, SshTarget,
    MAX_MESSAGE, TTL_SECONDS,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use std::{
    collections::HashSet,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub request_id: String,
    pub device_name: String,
    pub fingerprint: String,
    pub verification_code: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub id: String,
    pub expires_at: u64,
    pub state: String,
    pub candidate: Option<Candidate>,
}
struct Pending {
    request: Option<PairingRequest>,
    state: &'static str,
    nonces: HashSet<Vec<u8>>,
}
struct Inner {
    invitation: Invitation,
    stopped: AtomicBool,
    pending: Mutex<Pending>,
}
pub struct PairingServer {
    inner: Arc<Inner>,
}
impl Drop for PairingServer {
    fn drop(&mut self) {
        self.inner.stopped.store(true, Ordering::Release);
    }
}

fn read_message(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut length = [0_u8; 4];
    read_before(stream, &mut length, deadline)?;
    let length = u32::from_be_bytes(length) as usize;
    if !(28..=MAX_MESSAGE).contains(&length) {
        return Err("Invalid pairing frame length".into());
    }
    let mut body = vec![0; length];
    read_before(stream, &mut body, deadline)?;
    Ok(body)
}
fn read_before(stream: &mut TcpStream, mut bytes: &mut [u8], deadline: Instant) -> Result<()> {
    while !bytes.is_empty() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|time| !time.is_zero())
            .ok_or("Pairing read timed out")?;
        // Whole milliseconds avoid Darwin rejecting a timeval whose rounded
        // fractional microseconds become 1_000_000 just below a whole second.
        let socket_timeout = Duration::from_millis(remaining.as_millis().max(1) as u64);
        // Refining SO_RCVTIMEO per chunk is an optimisation, not the deadline:
        // the loop re-checks the deadline between reads, so a rejected or
        // ineffective timeout cannot turn a slow sender into a dropped pairing.
        let _ = stream.set_read_timeout(Some(socket_timeout));
        match stream.read(bytes) {
            Ok(0) => return Err("Pairing connection interrupted".into()),
            Ok(count) => bytes = &mut bytes[count..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            // A short read window expiring is not a protocol error: retry until
            // the deadline above decides.
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return Err("Pairing connection interrupted or timed out".into()),
        }
    }
    Ok(())
}
fn write_message(stream: &mut TcpStream, bytes: &[u8]) -> Result<()> {
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(bytes))
        .and_then(|_| stream.flush())
        .map_err(|_| "Pairing connection interrupted".into())
}
impl PairingServer {
    pub fn start(bind: SocketAddr, address: String, ssh: SshTarget) -> Result<Self> {
        ssh.validate()?;
        let listener =
            TcpListener::bind(bind).map_err(|_| "Cannot start temporary pairing listener")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Cannot configure pairing listener")?;
        let mut secret = Zeroizing::new([0_u8; 32]);
        getrandom::getrandom(secret.as_mut()).map_err(|_| "Random generator unavailable")?;
        let invitation = Invitation {
            version: 1,
            id: random_id()?,
            address,
            port: listener
                .local_addr()
                .map_err(|_| "Cannot read pairing address")?
                .port(),
            secret: URL_SAFE_NO_PAD.encode(secret.as_ref()),
            expires_at: now() + TTL_SECONDS,
            ssh,
        };
        invitation.validate()?;
        let inner = Arc::new(Inner {
            invitation,
            stopped: AtomicBool::new(false),
            pending: Mutex::new(Pending {
                request: None,
                state: "waiting",
                nonces: HashSet::new(),
            }),
        });
        let server = Arc::clone(&inner);
        thread::spawn(move || {
            let mut connections = 0;
            while !server.stopped.load(Ordering::Acquire)
                && now() < server.invitation.expires_at
                && connections < 512
            {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        connections += 1;
                        // macOS/BSD give the accepted socket the listener's
                        // non-blocking flag, so every read returned EAGAIN the
                        // moment the client's bytes had not landed yet and the
                        // timeouts below never applied: the request was dropped
                        // (the client saw a reset connection) whenever the
                        // connect/write was even slightly delayed. Linux returns
                        // a blocking socket here, which is why this only showed
                        // up on macOS or under load.
                        let _ = stream.set_nonblocking(false);
                        // Upper bound for one request/reply round trip; the
                        // protocol deadline inside read_message is tighter.
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                        let result = read_message(&mut stream)
                            .and_then(|body| handle(&server, &body))
                            .and_then(|reply| server.invitation.seal("reply", &reply))
                            .and_then(|body| write_message(&mut stream, &body));
                        // Invalid/replayed/expired messages receive no plaintext details.
                        let _ = result;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(30))
                    }
                    Err(_) => break,
                }
            }
            server.stopped.store(true, Ordering::Release);
        });
        Ok(Self { inner })
    }
    pub fn invitation(&self) -> &Invitation {
        &self.inner.invitation
    }
    pub fn status(&self) -> Result<PairingStatus> {
        let pending = self
            .inner
            .pending
            .lock()
            .map_err(|_| "Pairing state unavailable")?;
        let state = if now() >= self.inner.invitation.expires_at {
            "expired"
        } else if self.inner.stopped.load(Ordering::Acquire) {
            "closed"
        } else {
            pending.state
        };
        Ok(PairingStatus {
            id: self.inner.invitation.id.clone(),
            expires_at: self.inner.invitation.expires_at,
            state: state.into(),
            candidate: pending.request.as_ref().map(|request| Candidate {
                request_id: request.request_id.clone(),
                device_name: request.device_name.clone(),
                fingerprint: crate::public_key_fingerprint(&request.public_key).unwrap_or_default(),
                verification_code: request.verification_code(&self.inner.invitation),
            }),
        })
    }
    pub fn decide(
        &self,
        request_id: &str,
        approve: bool,
        ssh_directory: &Path,
        bridge: &Path,
    ) -> Result<()> {
        self.inner.invitation.validate()?;
        if self.inner.stopped.load(Ordering::Acquire) {
            return Err("Pairing listener is closed".into());
        }
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|_| "Pairing state unavailable")?;
        if pending.state != "pending" {
            return Err("No pending pairing decision".into());
        }
        let request = pending.request.as_ref().ok_or("No pending device")?;
        if request.request_id != request_id {
            return Err("The requesting device changed".into());
        }
        if approve {
            authorize(
                ssh_directory,
                request_id,
                &request.device_name,
                &request.public_key,
                bridge,
            )?;
        }
        pending.state = if approve { "approved" } else { "denied" };
        Ok(())
    }
}
fn handle(inner: &Inner, body: &[u8]) -> Result<PairingReply> {
    if inner.stopped.load(Ordering::Acquire) {
        return Err("Pairing listener is closed".into());
    }
    let request: PairingRequest = inner.invitation.open("request", body)?;
    request.validate()?;
    let mut pending = inner
        .pending
        .lock()
        .map_err(|_| "Pairing state unavailable")?;
    if pending.nonces.len() >= 256 || !pending.nonces.insert(body[..12].to_vec()) {
        return Err("Pairing request replayed or rate limit exceeded".into());
    }
    match &pending.request {
        Some(previous)
            if previous.request_id != request.request_id
                || previous.public_key != request.public_key
                || previous.device_name != request.device_name =>
        {
            return Ok(PairingReply {
                request_id: request.request_id,
                state: "busy".into(),
                ssh: None,
            })
        }
        None => {
            pending.request = Some(request.clone());
            pending.state = "pending";
        }
        _ => {}
    }
    Ok(PairingReply {
        request_id: request.request_id,
        state: pending.state.into(),
        ssh: (pending.state == "approved").then(|| inner.invitation.ssh.clone()),
    })
}

pub fn exchange(invitation: &Invitation, request: &PairingRequest) -> Result<PairingReply> {
    invitation.validate()?;
    request.validate()?;
    let addresses = (invitation.address.as_str(), invitation.port)
        .to_socket_addrs()
        .map_err(|_| "Cannot resolve the pairing computer")?;
    let mut connected = None;
    for address in addresses.take(4) {
        if let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(5)) {
            connected = Some(stream);
            break;
        }
    }
    let mut stream =
        connected.ok_or("Cannot reach the pairing computer; check Wi-Fi/VPN and firewall")?;
    // Generous on purpose: a loaded machine (or a busy CI box running this
    // suite next to every other one) needs more than the few seconds the
    // in-process server takes when idle. Timing this out aborts the bootstrapping
    // client's read and the server then observes EOF ("connection interrupted").
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(15))))
        .map_err(|_| "Cannot configure pairing connection")?;
    write_message(&mut stream, &invitation.seal("request", request)?)?;
    let reply: PairingReply = invitation.open("reply", &read_message(&mut stream)?)?;
    if reply.request_id != request.request_id
        || (reply.state == "approved" && reply.ssh.as_ref() != Some(&invitation.ssh))
    {
        return Err("Pairing reply identity mismatch".into());
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_loopback_requires_explicit_approval_and_only_one_key_can_claim_code() {
        let temp = tempfile::tempdir().unwrap();
        let ssh = temp.path().join("ssh");
        let server = PairingServer::start(
            "127.0.0.1:0".parse().unwrap(),
            "127.0.0.1".into(),
            crate::tests::invitation().ssh.clone(),
        )
        .unwrap();
        let request = PairingRequest {
            request_id: random_id().unwrap(),
            device_name: "Temporary test phone".into(),
            public_key: crate::tests::key(),
        };
        assert_eq!(
            exchange(server.invitation(), &request).unwrap().state,
            "pending"
        );
        assert!(!ssh.exists());
        let mut other = request.clone();
        other.request_id = random_id().unwrap();
        assert_eq!(exchange(server.invitation(), &other).unwrap().state, "busy");
        assert!(server
            .decide(&other.request_id, true, &ssh, Path::new("/test/bridge"))
            .is_err());
        let frame = server.invitation().seal("request", &request).unwrap();
        assert!(handle(&server.inner, &frame).is_ok());
        assert!(handle(&server.inner, &frame).is_err());
        server
            .decide(&request.request_id, true, &ssh, Path::new("/test/bridge"))
            .unwrap();
        assert_eq!(
            exchange(server.invitation(), &request).unwrap().state,
            "approved"
        );
        assert!(server
            .decide(&request.request_id, true, &ssh, Path::new("/test/bridge"))
            .is_err());
        assert_eq!(crate::devices(&ssh).unwrap().len(), 1);
    }
    #[test]
    fn rejection_writes_no_authorization() {
        let temp = tempfile::tempdir().unwrap();
        let ssh = temp.path().join("ssh");
        let server = PairingServer::start(
            "127.0.0.1:0".parse().unwrap(),
            "127.0.0.1".into(),
            crate::tests::invitation().ssh.clone(),
        )
        .unwrap();
        let request = PairingRequest {
            request_id: random_id().unwrap(),
            device_name: "Test".into(),
            public_key: crate::tests::key(),
        };
        exchange(server.invitation(), &request).unwrap();
        server
            .decide(&request.request_id, false, &ssh, Path::new("/bridge"))
            .unwrap();
        assert_eq!(
            exchange(server.invitation(), &request).unwrap().state,
            "denied"
        );
        assert!(!ssh.exists());
    }
    #[test]
    fn frame_reads_observe_an_absolute_deadline_and_invalid_lengths_fail_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut accepted, _) = listener.accept().unwrap();
        let start = Instant::now();
        assert!(read_before(
            &mut accepted,
            &mut [0; 4],
            start + Duration::from_millis(40)
        )
        .is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut accepted, _) = listener.accept().unwrap();
        client.write_all(&u32::MAX.to_be_bytes()).unwrap();
        assert!(read_message(&mut accepted).unwrap_err().contains("length"));
    }
}
