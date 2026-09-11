//! Conservative v1 live-screen rules. No text is exported as event evidence.
//! These supplement lifecycle integrations; no match means no observation.
use crate::state::Observation;
use regex::Regex;

pub struct ScreenDetector {
    needs_input: Regex,
    working: Regex,
    last: Option<&'static str>,
}
impl Default for ScreenDetector {
    fn default() -> Self {
        Self {
            // Restrict generic matching to the last nonempty line and an
            // explicit interactive suffix, not incidental transcript prose.
            needs_input: Regex::new(r"(?i)^(?:.*\b(?:proceed|continue|confirm|approve|allow)[^\n]*\([yY]/[nN]\)\s*[:?]?|press enter to (?:confirm|continue)[.!]?)\s*$").expect("static input rule"),
            working: Regex::new(r"(?i)^\s*(?:esc to interrupt|thinking\.{3}|running\.{3})\s*$").expect("static working rule"),
            last: None,
        }
    }
}
impl ScreenDetector {
    pub fn detect(&mut self, text: &str, needs_input_enabled: bool) -> Option<Observation> {
        let last_line = text
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("");
        let rule = if needs_input_enabled && self.needs_input.is_match(last_line.trim()) {
            Some("screen:v1:input-control:last-line")
        } else if self.working.is_match(last_line.trim()) {
            Some("screen:v1:working-control:last-line")
        } else {
            None
        };
        let changed = self.last != rule;
        self.last = rule;
        if !changed {
            return None;
        }
        match rule {
            Some("screen:v1:input-control:last-line") => {
                Some(Observation::PtyNeedsInputPattern(rule?.into()))
            }
            Some(_) => Some(Observation::PtyWorkingPattern(rule?.into())),
            None => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_current_control_and_never_infers_completion() {
        let mut detector = ScreenDetector::default();
        assert!(detector
            .detect("Do you want to proceed? (y/n)", true)
            .is_some());
        assert!(detector
            .detect("Do you want to proceed? (y/n)", true)
            .is_none());
        assert!(detector
            .detect("Do you want to proceed? (y/n)\nReady for new input", true)
            .is_none());
        assert!(detector.detect("", true).is_none());
        assert!(detector
            .detect("Do you want to proceed? (y/n)", false)
            .is_none());
        assert!(matches!(
            detector.detect("Esc to interrupt", true),
            Some(Observation::PtyWorkingPattern(_))
        ));
        assert!(detector
            .detect("The documentation mentions allow this and approve?", true)
            .is_none());
    }
}
