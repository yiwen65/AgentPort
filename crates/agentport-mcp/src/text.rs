//! Bounded, model-facing rendering of terminal bytes.
//!
//! Terminal output is a differential byte stream: it can carry escape
//! sequences, carriage-return overwrites and multi-megabyte redraws. Tool
//! results must stay small and readable, so everything that leaves this crate
//! passes through these helpers.

/// Default `read_output` tail. Terminal UIs redraw full screens, so a smaller
/// window is often useless; 16 KiB is roughly 200 lines of ordinary text.
pub const DEFAULT_READ_BYTES: usize = 16 * 1024;
/// Hard ceiling for a single tool result tail.
pub const MAX_READ_BYTES: usize = 64 * 1024;
/// Ceiling for the tail carried inside `wait_for_task`.
pub const WAIT_TAIL_BYTES: usize = 8 * 1024;

/// Convert raw PTY bytes into display text: strip optional escape sequences,
/// drop NULs and carriage returns, keep newlines.
pub fn render(bytes: &[u8], strip_escapes: bool) -> String {
    let stripped = if strip_escapes {
        strip_ansi_escapes::strip(bytes)
    } else {
        bytes.to_vec()
    };
    let filtered: Vec<u8> = stripped
        .into_iter()
        .filter(|byte| *byte != 0 && *byte != b'\r')
        .collect();
    String::from_utf8_lossy(&filtered).into_owned()
}

/// Keep at most `max_bytes` from the end, on a char boundary.
pub fn tail(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    (text[start..].to_string(), true)
}

/// Append `chunk` and keep the buffer under `cap` bytes, trimming from the
/// front on a char boundary.
pub fn push_bounded(buffer: &mut String, chunk: &str, cap: usize) {
    buffer.push_str(chunk);
    if buffer.len() <= cap {
        return;
    }
    let (trimmed, _) = tail(buffer, cap);
    buffer.clear();
    buffer.push_str(&trimmed);
}

/// A prompt must be a single line of text: no escape sequences, no NULs, and
/// bounded length so a runaway model cannot paste a megabyte into a TUI.
pub const MAX_PROMPT_BYTES: usize = 8 * 1024;

pub fn sanitize_prompt(input: &str) -> Result<String, String> {
    if input.trim().is_empty() {
        return Err("prompt must not be empty".into());
    }
    if input.len() > MAX_PROMPT_BYTES {
        return Err(format!(
            "prompt exceeds {MAX_PROMPT_BYTES} bytes; split the task"
        ));
    }
    if input.contains('\u{1b}') {
        return Err("prompt must not contain ESC (terminal control) sequences".into());
    }
    if input.contains('\n') {
        // A newline would submit the first line and leave the rest as raw input
        // to whatever prompt the TUI shows next.
        return Err("prompt must be a single line; join lines with spaces".into());
    }
    if input.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err("prompt must not contain control characters".into());
    }
    Ok(input.replace('\r', ""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_strips_escapes_and_carriage_returns() {
        let text = render(b"\x1b[?1034hsh-3.2$ echo hi\r\nhi\r\n", true);
        assert_eq!(text, "sh-3.2$ echo hi\nhi\n");
    }

    #[test]
    fn render_can_keep_escapes() {
        let text = render(b"\x1b[1mhi", false);
        assert!(text.contains('\u{1b}'));
    }

    #[test]
    fn tail_keeps_the_end_and_reports_truncation() {
        let (kept, truncated) = tail("0123456789", 4);
        assert_eq!(kept, "6789");
        assert!(truncated);
        let (kept, truncated) = tail("short", 16);
        assert_eq!(kept, "short");
        assert!(!truncated);
    }

    #[test]
    fn tail_respects_char_boundaries() {
        let text = "aé漢";
        let (kept, truncated) = tail(text, 4);
        assert!(truncated);
        assert_eq!(kept, "漢");
    }

    #[test]
    fn push_bounded_trims_from_the_front() {
        let mut buffer = String::new();
        push_bounded(&mut buffer, "abcdef", 4);
        push_bounded(&mut buffer, "gh", 4);
        assert_eq!(buffer, "efgh");
    }

    #[test]
    fn prompts_reject_control_sequences() {
        assert!(sanitize_prompt("read the tests").is_ok());
        assert!(sanitize_prompt("   ").is_err());
        assert!(sanitize_prompt("bad\u{1b}[2J").is_err());
        assert!(sanitize_prompt("null\0").is_err());
        // One prompt is one line: a newline would submit and then leak the rest
        // into whatever the TUI asks next.
        assert!(sanitize_prompt("echo ONE\necho TWO").is_err());
    }
}
