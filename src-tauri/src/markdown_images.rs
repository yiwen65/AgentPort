//! Anonymous, bounded image loading for Markdown. No filesystem or authenticated HTTP access.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageFormat, ImageReader, Limits};
use quick_xml::{events::Event, Reader};
use reqwest::{redirect::Policy, Url};
use serde::Serialize;
use std::{
    io::Cursor,
    net::{IpAddr, SocketAddr},
    time::Duration,
};

const MAX_BYTES: usize = 20 * 1024 * 1024;
const MAX_PIXELS: u64 = 20_000_000;
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Serialize)]
pub struct ImageError {
    code: &'static str,
    message: String,
}
type Result<T> = std::result::Result<T, ImageError>;
fn error(code: &'static str, message: impl Into<String>) -> ImageError {
    ImageError {
        code,
        message: message.into(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownImage {
    mime: &'static str,
    width: u32,
    height: u32,
    content_base64: String,
}

fn has_credentials(raw: &str) -> bool {
    raw.split_once("://")
        .map(|(_, rest)| rest)
        .or_else(|| raw.strip_prefix("//"))
        .is_some_and(|rest| {
            rest.split(['/', '?', '#'])
                .next()
                .unwrap_or("")
                .contains('@')
        })
}

fn checked_url(raw: &str) -> Result<Url> {
    if raw.len() > 8192 {
        return Err(error("invalid_url", "Image URL is too long"));
    }
    let mut url = Url::parse(raw).map_err(|_| error("invalid_url", "Invalid image URL"))?;
    if !raw
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || has_credentials(raw)
    {
        return Err(error(
            "blocked_url",
            "Images require anonymous public HTTPS",
        ));
    }
    url.set_fragment(None);
    Ok(url)
}

// Fail closed for special-purpose space, including mapped, translation, tunnel and documentation IPs.
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

fn checked_addresses(addresses: Vec<SocketAddr>) -> Result<Vec<SocketAddr>> {
    if addresses.is_empty() || addresses.iter().any(|addr| !public_ip(addr.ip())) {
        return Err(error(
            "blocked_address",
            "Image host must resolve only to public addresses",
        ));
    }
    Ok(addresses)
}

async fn resolve(url: &Url) -> Result<(String, Vec<SocketAddr>)> {
    let host = url
        .host_str()
        .ok_or_else(|| error("invalid_url", "Missing image host"))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((host.as_str(), port)),
        )
        .await
        .map_err(|_| error("timeout", "Image DNS lookup timed out"))?
        .map_err(|_| error("network", "Image DNS lookup failed"))?
        .collect()
    };
    Ok((host, checked_addresses(addresses)?))
}

fn redirect_url(current: &Url, location: &str, followed: usize) -> Result<Url> {
    if followed >= MAX_REDIRECTS {
        return Err(error("redirect_limit", "Too many image redirects"));
    }
    if has_credentials(location) {
        return Err(error(
            "blocked_url",
            "Image redirects cannot contain credentials",
        ));
    }
    let next = current
        .join(location)
        .map_err(|_| error("invalid_url", "Invalid image redirect"))?;
    checked_url(next.as_str())
}

async fn fetch(raw: &str) -> Result<MarkdownImage> {
    let mut url = checked_url(raw)?;
    for followed in 0..=MAX_REDIRECTS {
        let (host, addresses) = resolve(&url).await?;
        // Build per hop: no cached DNS/connections or automatic redirect can bypass validation.
        let client = reqwest::Client::builder()
            .no_proxy()
            .referer(false)
            .https_only(true)
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|_| error("network", "Could not initialize image request"))?;
        let mut response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| error("network", "Image request failed"))?;
        let status = response.status();
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or_else(|| error("invalid_url", "Missing image redirect target"))?;
            url = redirect_url(&url, location, followed)?;
            continue;
        }
        if !status.is_success() {
            return Err(error(
                "http_error",
                format!("Image server returned HTTP {}", status.as_u16()),
            ));
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
        {
            return Err(error("byte_limit", "Image exceeds 20 MiB"));
        }
        let declared_mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| error("network", "Image download interrupted"))?
        {
            if chunk.len() > MAX_BYTES - bytes.len() {
                return Err(error("byte_limit", "Image exceeds 20 MiB"));
            }
            bytes.extend_from_slice(&chunk);
        }
        return tauri::async_runtime::spawn_blocking(move || {
            validate(&bytes, declared_mime.as_deref())
        })
        .await
        .map_err(|_| error("internal", "Image validation worker stopped"))?;
    }
    Err(error("redirect_limit", "Too many image redirects"))
}

#[tauri::command]
pub async fn markdown_image_fetch(url: String) -> Result<MarkdownImage> {
    tokio::time::timeout(Duration::from_secs(60), fetch(&url))
        .await
        .map_err(|_| error("timeout", "Image request timed out"))?
}

#[tauri::command]
pub async fn markdown_image_validate(content_base64: String) -> Result<MarkdownImage> {
    if content_base64.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(error("byte_limit", "Image exceeds 20 MiB"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = STANDARD
            .decode(content_base64)
            .map_err(|_| error("invalid_image", "Invalid image encoding"))?;
        validate(&bytes, None)
    })
    .await
    .map_err(|_| error("internal", "Image validation worker stopped"))?
}

fn dimensions(width: u32, height: u32) -> Result<(u32, u32)> {
    if width == 0 || height == 0 {
        return Err(error("invalid_image", "Image has no dimensions"));
    }
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(error("pixel_limit", "Image exceeds 20 million pixels"));
    }
    Ok((width, height))
}

fn validate(bytes: &[u8], declared: Option<&str>) -> Result<MarkdownImage> {
    if bytes.len() > MAX_BYTES {
        return Err(error("byte_limit", "Image exceeds 20 MiB"));
    }
    let (mime, width, height) = if let Ok(format) = image::guess_format(bytes) {
        let mime = match format {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::WebP => "image/webp",
            ImageFormat::Gif => "image/gif",
            _ => return Err(error("unsupported_format", "Unsupported image format")),
        };
        // Gate dimensions without allocating decoder/header structures first. Non-PNG
        // image constructors receive limits only *after* their header initialization.
        let (width, height) = bounded_header_dimensions(bytes, format)?;
        if format == ImageFormat::Gif {
            gif_frames(bytes, width, height)?;
        }
        let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
        let mut limits = Limits::default();
        limits.max_alloc = Some(MAX_BYTES as u64);
        limits.max_image_width = Some(width);
        limits.max_image_height = Some(height);
        reader.limits(limits);
        let decoded_dimensions = reader
            .into_dimensions()
            .map_err(|_| error("invalid_image", "Invalid image header"))?;
        if decoded_dimensions != (width, height) {
            return Err(error(
                "invalid_image",
                "Inconsistent image header dimensions",
            ));
        }
        // Do not allocate a decoded raster here. The browser only receives the
        // body after this dimension gate and reports damaged compressed payloads.
        (mime, width, height)
    } else {
        let (width, height) = svg_dimensions(bytes)?;
        ("image/svg+xml", width, height)
    };
    if let Some(declared) = declared {
        let declared = declared
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !declared.is_empty() && declared != "application/octet-stream" && declared != mime {
            return Err(error(
                "mime_mismatch",
                "Image body does not match its Content-Type",
            ));
        }
    }
    Ok(MarkdownImage {
        mime,
        width,
        height,
        content_base64: STANDARD.encode(bytes),
    })
}

// Minimal, allocation-free format header gate. The library still validates its
// own format headers afterward. PNG applies the allocation limit at construction;
// other decoders apply it afterward, so this early gate is essential.
fn bounded_header_dimensions(bytes: &[u8], format: ImageFormat) -> Result<(u32, u32)> {
    let invalid = || error("invalid_image", "Invalid image header");
    let be16 = |b: &[u8]| u32::from(u16::from_be_bytes([b[0], b[1]]));
    let le16 = |b: &[u8]| u32::from(u16::from_le_bytes([b[0], b[1]]));
    let le24 = |b: &[u8]| u32::from(b[0]) | (u32::from(b[1]) << 8) | (u32::from(b[2]) << 16);
    let size = match format {
        ImageFormat::Png => {
            let header = bytes.get(..24).ok_or_else(invalid)?;
            if &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[8..16] != b"\x00\x00\x00\x0dIHDR" {
                return Err(invalid());
            }
            (
                u32::from_be_bytes(header[16..20].try_into().unwrap()),
                u32::from_be_bytes(header[20..24].try_into().unwrap()),
            )
        }
        ImageFormat::Gif => {
            let header = bytes.get(..10).ok_or_else(invalid)?;
            if &header[..6] != b"GIF87a" && &header[..6] != b"GIF89a" {
                return Err(invalid());
            }
            (le16(&header[6..8]), le16(&header[8..10]))
        }
        ImageFormat::Jpeg => {
            if !bytes.starts_with(b"\xff\xd8") {
                return Err(invalid());
            }
            let mut pos = 2;
            loop {
                if bytes.get(pos) != Some(&0xff) {
                    return Err(invalid());
                }
                while bytes.get(pos) == Some(&0xff) {
                    pos += 1;
                }
                let marker = *bytes.get(pos).ok_or_else(invalid)?;
                pos += 1;
                if matches!(marker, 0x00 | 0xd8 | 0xd9 | 0xda) {
                    return Err(invalid());
                }
                if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                    continue;
                }
                let length = be16(bytes.get(pos..pos + 2).ok_or_else(invalid)?) as usize;
                if length < 2 {
                    return Err(invalid());
                }
                let segment = bytes.get(pos..pos + length).ok_or_else(invalid)?;
                if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                    if segment.len() < 8 {
                        return Err(invalid());
                    }
                    break (be16(&segment[5..7]), be16(&segment[3..5]));
                }
                pos += length;
            }
        }
        ImageFormat::WebP => {
            let header = bytes.get(..20).ok_or_else(invalid)?;
            if &header[..4] != b"RIFF" || &header[8..12] != b"WEBP" {
                return Err(invalid());
            }
            let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64 + 8;
            if length != bytes.len() as u64 {
                return Err(invalid());
            }
            let chunk_length = u32::from_le_bytes(header[16..20].try_into().unwrap()) as usize;
            let data = bytes
                .get(20..20usize.checked_add(chunk_length).ok_or_else(invalid)?)
                .ok_or_else(invalid)?;
            match &header[12..16] {
                b"VP8X" if data.len() == 10 => (le24(&data[4..7]) + 1, le24(&data[7..10]) + 1),
                b"VP8L" if data.len() >= 5 && data[0] == 0x2f && data[4] & 0xe0 == 0 => {
                    let bits = u32::from_le_bytes(data[1..5].try_into().unwrap());
                    ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
                }
                b"VP8 "
                    if data.len() >= 10 && data[0] & 1 == 0 && &data[3..6] == b"\x9d\x01\x2a" =>
                {
                    (le16(&data[6..8]) & 0x3fff, le16(&data[8..10]) & 0x3fff)
                }
                _ => return Err(invalid()),
            }
        }
        _ => return Err(invalid()),
    };
    dimensions(size.0, size.1)
}

// GIF frame rectangles can differ from the logical-screen header. Validate every
// rectangle and block boundary without decompressing or allocating frame pixels.
fn gif_frames(bytes: &[u8], width: u32, height: u32) -> Result<()> {
    let invalid = || error("invalid_image", "Malformed GIF image");
    fn take<'a>(bytes: &'a [u8], pos: &mut usize, length: usize) -> Option<&'a [u8]> {
        let end = pos.checked_add(length)?;
        let slice = bytes.get(*pos..end)?;
        *pos = end;
        Some(slice)
    }
    fn blocks(bytes: &[u8], pos: &mut usize) -> Option<()> {
        loop {
            let length = *take(bytes, pos, 1)?.first()? as usize;
            if length == 0 {
                return Some(());
            }
            take(bytes, pos, length)?;
        }
    }
    let mut pos = 0;
    let header = take(bytes, &mut pos, 13).ok_or_else(invalid)?;
    if header[10] & 0x80 != 0 {
        take(bytes, &mut pos, 3 * (1usize << ((header[10] & 7) + 1))).ok_or_else(invalid)?;
    }
    let mut frames = 0;
    loop {
        match *take(bytes, &mut pos, 1)
            .ok_or_else(invalid)?
            .first()
            .ok_or_else(invalid)?
        {
            0x21 => {
                take(bytes, &mut pos, 1).ok_or_else(invalid)?;
                blocks(bytes, &mut pos).ok_or_else(invalid)?;
            }
            0x2c => {
                let descriptor = take(bytes, &mut pos, 9).ok_or_else(invalid)?;
                let number = |offset| {
                    u32::from(u16::from_le_bytes([
                        descriptor[offset],
                        descriptor[offset + 1],
                    ]))
                };
                let (left, top, w, h) = (number(0), number(2), number(4), number(6));
                dimensions(w, h)?;
                if left + w > width || top + h > height {
                    return Err(error(
                        "invalid_image",
                        "GIF frame exceeds its image viewport",
                    ));
                }
                if descriptor[8] & 0x80 != 0 {
                    take(bytes, &mut pos, 3 * (1usize << ((descriptor[8] & 7) + 1)))
                        .ok_or_else(invalid)?;
                }
                let code_size = take(bytes, &mut pos, 1).ok_or_else(invalid)?[0];
                if !(2..=8).contains(&code_size) || bytes.get(pos).is_none_or(|n| *n == 0) {
                    return Err(invalid());
                }
                blocks(bytes, &mut pos).ok_or_else(invalid)?;
                frames += 1;
            }
            0x3b if frames > 0 && pos == bytes.len() => return Ok(()),
            _ => return Err(invalid()),
        }
    }
}

fn svg_number(value: &str) -> Result<f64> {
    let n = value
        .trim()
        .trim_end_matches("px")
        .parse::<f64>()
        .map_err(|_| error("invalid_image", "SVG requires numeric pixel dimensions"))?;
    if !n.is_finite() || n <= 0.0 || n > MAX_PIXELS as f64 {
        return Err(error("pixel_limit", "Invalid or oversized SVG dimensions"));
    }
    Ok(n)
}

fn svg_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    let xml = std::str::from_utf8(bytes).map_err(|_| {
        error(
            "invalid_image",
            "Image is not supported raster or UTF-8 SVG",
        )
    })?;
    // DTD/custom entities are rejected by events; predefined/numeric XML escapes remain valid.
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    let mut root_seen = false;
    let mut nodes = 0usize;
    let mut size = None;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| error("invalid_image", "Malformed SVG XML"))?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                nodes += 1;
                if nodes > 20_000 {
                    return Err(error("invalid_image", "SVG XML has too many elements"));
                }
                for attr in tag.attributes() {
                    let attr =
                        attr.map_err(|_| error("invalid_image", "Malformed SVG attribute"))?;
                    attr.decode_and_unescape_value(reader.decoder()).map_err(|_| error("unsafe_svg", "Invalid SVG attribute escape"))?;
                    if attr.value.contains(&b'<') {
                        return Err(error("invalid_image", "Malformed SVG attribute"));
                    }
                }
                if depth == 0 {
                    if root_seen || tag.name().as_ref() != b"svg" {
                        return Err(error("invalid_image", "Image must have one SVG root"));
                    }
                    root_seen = true;
                    let (mut width, mut height, mut viewbox) = (None, None, None);
                    for attr in tag.attributes() {
                        let attr =
                            attr.map_err(|_| error("invalid_image", "Malformed SVG attribute"))?;
                        let value = attr.decode_and_unescape_value(reader.decoder())
                            .map_err(|_| error("invalid_image", "Invalid SVG attribute"))?;
                        match attr.key.as_ref() {
                            b"xmlns" if value.as_ref() != "http://www.w3.org/2000/svg" => {
                                return Err(error("invalid_image", "Invalid SVG namespace"))
                            }
                            b"width" => width = Some(svg_number(&value)?),
                            b"height" => height = Some(svg_number(&value)?),
                            b"viewBox" => {
                                let values: Vec<_> = value
                                    .split(|c: char| c.is_ascii_whitespace() || c == ',')
                                    .filter(|v| !v.is_empty())
                                    .collect();
                                if values.len() != 4
                                    || values[..2]
                                        .iter()
                                        .any(|v| v.parse::<f64>().map_or(true, |n| !n.is_finite()))
                                {
                                    return Err(error("invalid_image", "Invalid SVG viewBox"));
                                }
                                let w = svg_number(values[2])?;
                                let h = svg_number(values[3])?;
                                dimensions(w.ceil() as u32, h.ceil() as u32)?;
                                viewbox = Some((w, h));
                            }
                            _ => {}
                        }
                    }
                    let w = width
                        .or(viewbox.map(|v| v.0))
                        .ok_or_else(|| error("invalid_image", "SVG width is missing"))?;
                    let h = height
                        .or(viewbox.map(|v| v.1))
                        .ok_or_else(|| error("invalid_image", "SVG height is missing"))?;
                    size = Some(dimensions(w.ceil() as u32, h.ceil() as u32)?);
                }
                // Bound parser nesting as well as byte length. Frontend sanitizes the static SVG subset.
                if !empty {
                    depth += 1;
                    if depth > 64 {
                        return Err(error("invalid_image", "SVG XML is too deeply nested"));
                    }
                }
            }
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| error("invalid_image", "Malformed SVG nesting"))?;
            }
            Event::GeneralRef(reference) => {
                let name = reference.decode().map_err(|_| error("invalid_image", "Invalid SVG character reference"))?;
                let numeric = reference.resolve_char_ref().map_err(|_| error("invalid_image", "Invalid SVG character reference"))?;
                let valid_numeric = numeric.is_some_and(|character| matches!(character as u32, 0x9 | 0xA | 0xD | 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF));
                if depth == 0 || !(valid_numeric || matches!(name.as_ref(), "amp" | "lt" | "gt" | "quot" | "apos")) {
                    return Err(error("unsafe_svg", "Custom SVG entities are not allowed"));
                }
            }
            Event::DocType(_) | Event::PI(_) => {
                return Err(error(
                    "unsafe_svg",
                    "SVG DTD, entities and processing instructions are not allowed",
                ))
            }
            Event::Text(text)
                if depth == 0 && !text.iter().all(u8::is_ascii_whitespace) =>
            {
                return Err(error("invalid_image", "Text outside SVG root"))
            }
            Event::CData(_) if depth == 0 => {
                return Err(error("invalid_image", "Text outside SVG root"))
            }
            Event::Decl(_) if root_seen => {
                return Err(error("invalid_image", "XML declaration after SVG root"))
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if depth != 0 {
        return Err(error("invalid_image", "Unclosed SVG root"));
    }
    size.ok_or_else(|| error("unsupported_format", "Unsupported image format"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn urls_and_redirects_are_anonymous_https() {
        for url in [
            "http://example.com/a.png",
            "file:///a.png",
            "data:image/png,x",
            "https://u:p@example.com/a",
            "https://@example.com/a",
        ] {
            assert!(checked_url(url).is_err(), "{url}");
        }
        let url = checked_url("https://example.com/a/image.png#anchor").unwrap();
        assert!(url.fragment().is_none());
        assert_eq!(
            redirect_url(&url, "../next.png", 4).unwrap().as_str(),
            "https://example.com/next.png"
        );
        assert!(redirect_url(&url, "http://example.com/a", 0).is_err());
        assert!(redirect_url(&url, "//u:p@example.com/a", 0).is_err());
        assert!(redirect_url(&url, "https://@example.com/a", 0).is_err());
        assert!(redirect_url(&url, "https://example.com/a", 5).is_err());
    }
    #[test]
    fn addresses_reject_special_and_mixed_dns() {
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "127.0.0.1",
            "100.64.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "::",
            "::1",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2002:808:808::1",
            "3fff::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public_ip(ip.parse().unwrap()));
        }
        assert!(checked_addresses(vec![]).is_err());
        assert!(checked_addresses(vec![
            "8.8.8.8:443".parse().unwrap(),
            "127.0.0.1:443".parse().unwrap()
        ])
        .is_err());
    }
    #[test]
    fn svg_requires_valid_xml_and_bounded_dimensions() {
        assert_eq!(svg_dimensions(br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M0 0"/></svg>"#).unwrap(), (100, 50));
        assert_eq!(svg_dimensions(b"<svg width='1' height='1'><text>&amp; &#x41; &#65;</text></svg>").unwrap(), (1, 1));
        for xml in [
            "<svg width='10000' height='10000'/>",
            "<svg width='1' height='1' viewBox='0 0 10000 10000'/>",
            "<!DOCTYPE svg><svg width='1' height='1'/>",
            "<svg width='1' height='1'>&external;</svg>",
            "<svg width='1' height='1'>&#0;</svg>",
            "<html/>",
            "<svg width='1' height='1'><g></svg>",
            "<svg width='1' height='1'/><svg width='1' height='1'/>",
            "<svg width='NaN' height='1'/>",
        ] {
            assert!(svg_dimensions(xml.as_bytes()).is_err(), "{xml}");
        }
    }
    #[test]
    fn svg_parser_complexity_is_bounded() {
        let nested = format!(
            "<svg width='1' height='1'>{}{}</svg>",
            "<g>".repeat(64),
            "</g>".repeat(64)
        );
        assert!(svg_dimensions(nested.as_bytes()).is_err());
        let many = format!("<svg width='1' height='1'>{}</svg>", "<g/>".repeat(20_000));
        assert!(svg_dimensions(many.as_bytes()).is_err());
    }
    #[test]
    fn gif_frame_rectangles_cannot_bypass_screen_limit() {
        let mut gif = b"GIF89a\x02\x00\x03\x00\x00\x00\x00".to_vec();
        gif.extend_from_slice(b"\x2c\x00\x00\x00\x00\xff\xff\xff\xff\x00\x02\x01\x00\x00\x3b");
        assert_eq!(gif_frames(&gif, 2, 3).unwrap_err().code, "pixel_limit");
        assert!(gif_frames(&gif[..13], 2, 3).is_err());
    }
    #[test]
    fn dimensions_are_gated_before_decoder_construction() {
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        png.extend_from_slice(&10_000_000u32.to_be_bytes());
        png.extend_from_slice(&3u32.to_be_bytes());
        let gif = b"GIF89a\xff\xff\xff\xff";
        let jpeg = b"\xff\xd8\xff\xc0\x00\x08\x08\xff\xff\xff\xff\x01";
        let mut webp = b"RIFF\x16\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00".to_vec();
        webp.extend_from_slice(&[0xff; 6]);
        for (bytes, format) in [
            (png.as_slice(), ImageFormat::Png),
            (gif.as_slice(), ImageFormat::Gif),
            (jpeg.as_slice(), ImageFormat::Jpeg),
            (webp.as_slice(), ImageFormat::WebP),
        ] {
            assert_eq!(
                bounded_header_dimensions(bytes, format).unwrap_err().code,
                "pixel_limit"
            );
            assert!(bounded_header_dimensions(&bytes[..8], format).is_err());
        }
    }
    #[test]
    fn raster_formats_are_sniffed_and_headers_validated() {
        for (format, mime) in [
            (ImageFormat::Png, "image/png"),
            (ImageFormat::Jpeg, "image/jpeg"),
            (ImageFormat::WebP, "image/webp"),
            (ImageFormat::Gif, "image/gif"),
        ] {
            let mut encoded = Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(2, 3)
                .write_to(&mut encoded, format)
                .unwrap();
            assert_eq!(
                bounded_header_dimensions(encoded.get_ref(), format).unwrap(),
                (2, 3)
            );
            let result = validate(encoded.get_ref(), Some(mime)).unwrap();
            assert_eq!((result.mime, result.width, result.height), (mime, 2, 3));
            assert!(validate(encoded.get_ref(), Some("text/html")).is_err());
            assert!(validate(&encoded.get_ref()[..10], None).is_err());
        }
        assert!(validate(b"not an image", None).is_err());
        assert!(validate(&vec![0; MAX_BYTES + 1], None).is_err());
        assert!(dimensions(5000, 4001).is_err());
        assert!(dimensions(0, 1).is_err());
        assert!(dimensions(5000, 4000).is_ok());
    }
}
