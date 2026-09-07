//! Extract terminal modes from locally retained output without forwarding text.
//! The phone receives this small seed plus its requested recent tail.
use std::collections::BTreeMap;

#[derive(Default)]
pub struct TerminalSeed {
    parser: vte::Parser<256>,
    modes: Modes,
}
impl TerminalSeed {
    pub fn advance(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.modes, bytes);
    }
    pub fn bytes(&self) -> Vec<u8> {
        let mut seed = String::new();
        for (&(private, mode), &enabled) in &self.modes.values {
            seed.push_str(&format!(
                "\x1b[{}{mode}{}",
                if private { "?" } else { "" },
                if enabled { 'h' } else { 'l' }
            ));
        }
        if let Some(mode) = self.modes.alternate {
            seed.push_str(&format!("\x1b[?{mode}h"));
        }
        if let Some(application) = self.modes.keypad {
            seed.push_str(if application { "\x1b=" } else { "\x1b>" });
        }
        seed.into_bytes()
    }
}
#[derive(Default)]
struct Modes {
    values: BTreeMap<(bool, u16), bool>,
    alternate: Option<u16>,
    keypad: Option<bool>,
}
impl vte::Perform for Modes {
    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        ignore: bool,
        action: char,
    ) {
        if ignore
            || !matches!(action, 'h' | 'l')
            || !(intermediates.is_empty() || intermediates == b"?")
        {
            return;
        }
        let private = intermediates == b"?";
        for param in params {
            let mode = param[0];
            if private && matches!(mode, 47 | 1047 | 1049) {
                self.alternate = (action == 'h').then_some(mode);
            } else if self.values.len() < 256 || self.values.contains_key(&(private, mode)) {
                self.values.insert((private, mode), action == 'h');
            }
        }
    }
    fn esc_dispatch(&mut self, intermediates: &[u8], ignore: bool, byte: u8) {
        if ignore || !intermediates.is_empty() {
            return;
        }
        match byte {
            b'c' => *self = Self::default(),
            b'=' => self.keypad = Some(true),
            b'>' => self.keypad = Some(false),
            _ => {}
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seed_preserves_split_modes_without_replaying_text_or_osc_contents() {
        let mut seed = TerminalSeed::default();
        seed.advance(b"private old text\x1b[?1049h\x1b[?100");
        seed.advance(b"3;1006h\x1b[?2004h\x1b]0;fake [?1003l\x07");
        assert_eq!(
            seed.bytes(),
            b"\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1049h"
        );
    }
    #[test]
    fn seed_tracks_alternate_exit_and_terminal_reset() {
        let mut seed = TerminalSeed::default();
        seed.advance(b"\x1b[?1049h\x1b[?1049l\x1b[?1003h");
        assert_eq!(seed.bytes(), b"\x1b[?1003h");
        seed.advance(b"\x1bc");
        assert!(seed.bytes().is_empty());
    }
}
