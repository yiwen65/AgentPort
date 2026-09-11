//! Conservative live-screen rules. These supplement lifecycle integrations.
use crate::state::Observation;
use regex::Regex;

pub struct ScreenDetector {
    needs_input: Regex,
    working: Regex,
    idle: Regex,
    last: Option<&'static str>,
}
impl Default for ScreenDetector {
    fn default() -> Self {
        Self {
            needs_input: Regex::new(r"(?i)^(?:.*\b(?:proceed|continue|confirm|approve|allow)[^\n]*\([yY]/[nN]\)\s*[:?]?|press enter to (?:confirm|continue)[.!]?)\s*$").expect("static input rule"),
            working: Regex::new(r"(?i)^\s*(?:[⏸⏵]\s*.*esc to interrupt|[*·✦✶✻✽]\s+\S.*…(?:\s+\(\d+[smh])?|esc to interrupt|thinking\.\.\.|running\.\.\.)\s*$|^\s*(?:esc to interrupt|thinking\.{3}|running\.{3})\s*$").expect("static working rule"),
            // Claude Code's prompt box uses a leading ❯. Keep this to the
            // last non-empty line and exclude menus/permission forms.
            idle: Regex::new(r"^\s*❯\s*$").expect("static idle rule"),
            last: None,
        }
    }
}
impl ScreenDetector {
    pub fn detect(&mut self, text: &str, needs_input_enabled: bool) -> Option<Observation> {
        let lines: Vec<_> = text.lines().collect();
        let last_line = lines.iter().rev().find(|line| !line.trim().is_empty()).copied().unwrap_or("");
        let recent = text;
        let rule = if needs_input_enabled
            && (self.needs_input.is_match(last_line.trim())
                || (recent.contains("esc to cancel") && (recent.contains("enter to confirm") || recent.contains("enter to select"))))
        {
            Some("screen:v1:input-control:last-line")
        } else if self.working.is_match(last_line.trim()) {
            Some("screen:v1:working-control")
        } else if lines.iter().rev().take(8).any(|line| self.idle.is_match(line))
            && !recent.contains("esc to cancel")
            && !recent.contains("enter to select") && !recent.contains("tab/arrow keys") {
            Some("screen:v1:agent-prompt-box")
        } else { None };
        if self.last == rule { return None; }
        self.last = rule;
        match rule {
            Some("screen:v1:input-control:last-line") => Some(Observation::PtyNeedsInputPattern(rule?.into())),
            Some("screen:v1:working-control") => Some(Observation::PtyWorkingPattern(rule?.into())),
            Some("screen:v1:agent-prompt-box") => Some(Observation::PtyIdlePattern(rule?.into())),
            None => None,
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_prompt_becomes_idle_but_menus_and_working_controls_do_not() {
        let mut detector = ScreenDetector::default();
        assert!(matches!(detector.detect("assistant output\n❯", true), Some(Observation::PtyIdlePattern(_))));
        let mut qoder = ScreenDetector::default();
        assert!(matches!(qoder.detect("Qoder ready\n❯", true), Some(Observation::PtyIdlePattern(_))));
        assert!(detector.detect("assistant output\n❯", true).is_none());
        // Historical transcript text must not keep a fresh prompt working.
        let mut fresh = ScreenDetector::default();
        assert!(matches!(fresh.detect("old output: esc to interrupt\n❯", true), Some(Observation::PtyIdlePattern(_))));
        assert!(matches!(detector.detect("esc to interrupt", true), Some(Observation::PtyWorkingPattern(_))));
        assert!(matches!(detector.detect("esc to interrupt\n❯", true), Some(Observation::PtyIdlePattern(_))));
        assert!(matches!(detector.detect("esc to cancel\nenter to confirm\n❯", true), Some(Observation::PtyNeedsInputPattern(_))));
        assert!(detector.detect("enter to select\n❯ 1. Yes\n❯", true).is_none());
    }
    #[test]
    fn generic_approval_rule_remains_conservative() {
        let mut detector = ScreenDetector::default();
        assert!(detector.detect("Do you want to proceed? (y/n)", true).is_some());
        assert!(detector.detect("Do you want to proceed? (y/n)", true).is_none());
        assert!(detector.detect("documentation mentions approve?", true).is_none());
    }
}
