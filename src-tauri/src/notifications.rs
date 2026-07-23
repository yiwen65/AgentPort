use agentport_core::error::Result;
use agentport_core::notify::Notification;
use tauri::AppHandle;

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub fn send(notification: &Notification) -> Result<()> {
    agentport_core::notify::deliver_notification(notification)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use agentport_core::error::CoreError;
    use block2::RcBlock;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{define_class, rc::Retained, AnyThread};
    use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::Duration;
    use tauri::Manager;

    const AGENTPORT_BUNDLE_ID: &str = "com.agentport.desktop";
    const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(30);
    const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);

    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
    static AUTHORIZED: AtomicBool = AtomicBool::new(false);
    static AUTHORIZATION_LOCK: Mutex<()> = Mutex::new(());
    static NEXT_NOTIFICATION_ID: AtomicU64 = AtomicU64::new(1);

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "AgentPortNotificationCenterDelegate"]
        struct NotificationDelegate;

        unsafe impl NSObjectProtocol for NotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present_notification(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion_handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                _response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                if let Some(app) = APP_HANDLE.get() {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                completion_handler.call(());
            }
        }
    );

    impl NotificationDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { objc2::msg_send![super(this), init] }
        }
    }

    pub fn install(app: &AppHandle) {
        static DELEGATE: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();

        let _ = APP_HANDLE.set(app.clone());
        DELEGATE.get_or_init(|| {
            let delegate = NotificationDelegate::new();
            let center = UNUserNotificationCenter::currentNotificationCenter();
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            delegate
        });
    }

    pub fn send(notification: &Notification) -> Result<()> {
        ensure_agentport_bundle()?;

        let center = UNUserNotificationCenter::currentNotificationCenter();
        ensure_authorized(&center)?;

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&notification.title));
        content.setBody(&NSString::from_str(&notification.body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));

        let sequence = NEXT_NOTIFICATION_ID.fetch_add(1, Ordering::Relaxed);
        let identifier = NSString::from_str(&format!(
            "agentport.{}.{}",
            notification.session_id, sequence
        ));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None,
        );

        let (tx, rx) = mpsc::sync_channel(1);
        let completion = RcBlock::new(move |error: *mut NSError| {
            let result = match error_description(error) {
                Some(error) => Err(error),
                None => Ok(()),
            };
            let _ = tx.send(result);
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));

        match rx.recv_timeout(DELIVERY_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(CoreError::Internal(format!(
                "native notification rejected: {error}"
            ))),
            Err(_) => Err(CoreError::Internal(
                "native notification delivery timed out".into(),
            )),
        }
    }

    fn ensure_agentport_bundle() -> Result<()> {
        let actual = NSBundle::mainBundle()
            .bundleIdentifier()
            .map(|identifier| identifier.to_string());
        if actual.as_deref() == Some(AGENTPORT_BUNDLE_ID) {
            Ok(())
        } else {
            Err(CoreError::Internal(format!(
                "native notifications require the AgentPort app bundle (expected {AGENTPORT_BUNDLE_ID}, got {})",
                actual.as_deref().unwrap_or("none")
            )))
        }
    }

    fn ensure_authorized(center: &UNUserNotificationCenter) -> Result<()> {
        if AUTHORIZED.load(Ordering::Acquire) {
            return Ok(());
        }
        let _guard = AUTHORIZATION_LOCK
            .lock()
            .map_err(|_| CoreError::Internal("notification authorization lock poisoned".into()))?;
        if AUTHORIZED.load(Ordering::Acquire) {
            return Ok(());
        }

        let (tx, rx) = mpsc::sync_channel(1);
        let completion = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let result = match error_description(error) {
                Some(error) => Err(error),
                None if granted.as_bool() => Ok(()),
                None => Err("notification permission denied".into()),
            };
            let _ = tx.send(result);
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &completion,
        );

        match rx.recv_timeout(AUTHORIZATION_TIMEOUT) {
            Ok(Ok(())) => {
                AUTHORIZED.store(true, Ordering::Release);
                Ok(())
            }
            Ok(Err(error)) => Err(CoreError::Internal(format!(
                "notification authorization failed: {error}"
            ))),
            Err(_) => Err(CoreError::Internal(
                "notification authorization timed out".into(),
            )),
        }
    }

    fn error_description(error: *mut NSError) -> Option<String> {
        NonNull::new(error)
            .map(|error| unsafe { error.as_ref() }.localizedDescription().to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn notifications_are_bound_to_agentport_bundle() {
            assert_eq!(AGENTPORT_BUNDLE_ID, "com.agentport.desktop");
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::{install, send};
