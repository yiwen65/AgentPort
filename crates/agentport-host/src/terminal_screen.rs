//! A bounded, in-process xterm 5.5 screen. No Node process, filesystem or network
//! access is exposed to JS. Keep feed/resize/snapshot under output_serial.
use rquickjs::{Context, Function, Object, Runtime, TypedArray};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(crate) struct TerminalScreen {
    context: Context,
    _runtime: Runtime,
    deadline: Arc<Mutex<Instant>>,
}
impl TerminalScreen {
    pub fn new(cols: u16, rows: u16) -> Result<Self, String> {
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_memory_limit(64 * 1024 * 1024);
        runtime.set_max_stack_size(512 * 1024);
        let deadline = Arc::new(Mutex::new(Instant::now() + Duration::from_secs(2)));
        let guard = deadline.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            Instant::now() >= *guard.lock().unwrap()
        })));
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;
        let screen = Self {
            context,
            _runtime: runtime,
            deadline,
        };
        screen.context.with(|ctx| -> rquickjs::Result<()> {
            ctx.eval::<(), _>("globalThis.process={title:'snapshot'};globalThis.exports={};globalThis.setTimeout=()=>1;globalThis.clearTimeout=()=>{};globalThis.setInterval=()=>1;globalThis.clearInterval=()=>{};globalThis.console={log(){},warn(){},error(){}};")?;
            ctx.eval::<(), _>(include_str!("../assets/terminal-snapshot/xterm.js"))?;
            ctx.eval::<(), _>(include_str!("../assets/terminal-snapshot/serialize.js"))?;
            ctx.eval::<(), _>(include_str!("../assets/terminal-snapshot/engine.js"))?;
            let engine: Object = ctx.globals().get("SnapshotEngine")?;
            engine.get::<_, Function>("init")?.call::<_, ()>((cols, rows))
        }).map_err(|e| e.to_string())?;
        Ok(screen)
    }
    pub fn feed(&self, data: &[u8]) -> Result<(), String> {
        *self.deadline.lock().unwrap() = Instant::now() + Duration::from_secs(1);
        self.context
            .with(|ctx| -> rquickjs::Result<()> {
                let engine: Object = ctx.globals().get("SnapshotEngine")?;
                let bytes = TypedArray::new_copy(ctx.clone(), data)?;
                engine.get::<_, Function>("feed")?.call::<_, ()>((bytes,))
            })
            .map_err(|e| e.to_string())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        *self.deadline.lock().unwrap() = Instant::now() + Duration::from_secs(1);
        self.context
            .with(|ctx| -> rquickjs::Result<()> {
                let engine: Object = ctx.globals().get("SnapshotEngine")?;
                engine
                    .get::<_, Function>("resize")?
                    .call::<_, ()>((cols, rows))
            })
            .map_err(|e| e.to_string())
    }
    pub fn snapshot(&self) -> Option<serde_json::Value> {
        *self.deadline.lock().unwrap() = Instant::now() + Duration::from_secs(1);
        let json = self
            .context
            .with(|ctx| -> rquickjs::Result<String> {
                let engine: Object = ctx.globals().get("SnapshotEngine")?;
                engine.get::<_, Function>("snapshot")?.call(())
            })
            .ok()?;
        // HelloOk shares the bounded 1 MiB Host frame with metadata. Keep
        // ample framing headroom rather than emitting an unreadable handshake.
        if json.len() > agentport_core::protocol::MAX_NDJSON_FRAME_BYTES / 2 {
            return None;
        }
        serde_json::from_str(&json)
            .ok()
            .filter(|value: &serde_json::Value| !value.is_null())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_screen_beyond_the_raw_tail_and_keeps_parser_prefix() {
        let screen = TerminalScreen::new(47, 53).unwrap();
        screen
            .feed(b"\x1b[?1049h\x1b[HHEADER\x1b[48;1HINPUT_TOP\x1b[50;1HINPUT_BOTTOM")
            .unwrap();
        for _ in 0..100 {
            screen.feed(&b"\x1b[46;1HWorking...".repeat(100)).unwrap();
        }
        screen.feed(b"\x1b[3;").unwrap();
        let saved = screen.snapshot().unwrap();
        assert!(saved["content"].as_str().unwrap().contains("HEADER"));
        assert!(saved["content"].as_str().unwrap().contains("INPUT_BOTTOM"));
        assert_eq!(saved["pending"], serde_json::json!([27, 91, 51, 59]));
        screen.feed(b"2HNEW").unwrap();
        screen.resize(60, 40).unwrap();
        let saved = screen.snapshot().unwrap();
        assert_eq!(saved["cols"], 60);
        assert_eq!(saved["rows"], 40);
        assert_eq!(saved["pending"], serde_json::json!([]));
    }
}
