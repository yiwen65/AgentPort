#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#import <objc/runtime.h>

// Native callbacks may precede the Tauri webview (notably a notification tap
// that cold-starts the app). Keep one target until Rust/JS explicitly take it.
static NSString *pushToken;
// Before the asynchronous OS settings callback, asking again is safe: iOS
// returns the already-decided state without another prompt.
static NSString *pushPermission = @"notDetermined";
#if DEBUG
static NSString *const pushEnvironment = @"sandbox";
#else
static NSString *const pushEnvironment = @"production";
#endif
static NSDictionary *pendingTap;
static void (*pushCallback)(const char *);

static NSString *permissionName(UNAuthorizationStatus status) {
    switch (status) {
        case UNAuthorizationStatusNotDetermined: return @"notDetermined";
        case UNAuthorizationStatusDenied: return @"denied";
        case UNAuthorizationStatusAuthorized: return @"authorized";
        case UNAuthorizationStatusProvisional: return @"provisional";
        case UNAuthorizationStatusEphemeral: return @"ephemeral";
        default: return @"unknown";
    }
}

static BOOL canRegister(UNAuthorizationStatus status) {
    return status == UNAuthorizationStatusAuthorized || status == UNAuthorizationStatusProvisional ||
           status == UNAuthorizationStatusEphemeral;
}

static void emitPush(NSString *name, NSDictionary *value) {
    void (*callback)(const char *);
    @synchronized ([UIApplication class]) { callback = pushCallback; }
    if (!callback) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"event": name, @"payload": value }
                                                   options:0 error:nil];
    if (data) callback([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
}

static void updatePermission(UNAuthorizationStatus status) {
    NSString *permission = permissionName(status);
    BOOL changed = NO;
    NSString *token;
    @synchronized ([UIApplication class]) {
        changed = ![pushPermission isEqualToString:permission];
        pushPermission = permission;
        if (!canRegister(status) && pushToken) {
            pushToken = nil;
            changed = YES;
        }
        token = pushToken;
    }
    // In particular, the first unknown -> notDetermined transition must wake
    // the webview so it can ask permission for an already-paired phone.
    if (changed) emitPush(@"mobile-push-token", @{ @"token": token ?: (id)[NSNull null], @"permission": permission, @"environment": pushEnvironment });
}

static NSDictionary *tapMetadata(NSDictionary *userInfo) {
    // APNs payloads are untrusted. Never forward aps, alert text, or arbitrary keys.
    id host = userInfo[@"hostId"], session = userInfo[@"sessionId"];
    if (![host isKindOfClass:[NSString class]] || ![session isKindOfClass:[NSString class]] ||
        ![host length] || ![session length] || [host length] > 256 || [session length] > 256) return nil;
    return @{ @"hostId": host, @"sessionId": session };
}

@interface AgentPortPushDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation AgentPortPushDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    NSDictionary *target = tapMetadata(response.notification.request.content.userInfo);
    if (target) {
        @synchronized ([UIApplication class]) { pendingTap = target; }
        emitPush(@"mobile-push-tap", target);
    }
    completionHandler();
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    // Foreground alerts remain visible; JS can refresh the authoritative inbox.
    NSDictionary *target = tapMetadata(notification.request.content.userInfo);
    if (target) emitPush(@"mobile-push-received", target);
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
}
@end

static AgentPortPushDelegate *notificationDelegate;

static void refreshPushRegistration(void) {
    [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        updatePermission(settings.authorizationStatus);
        if (canRegister(settings.authorizationStatus)) {
            dispatch_async(dispatch_get_main_queue(), ^{ [[UIApplication sharedApplication] registerForRemoteNotifications]; });
        }
    }];
}

// Called before Tao creates UIApplication, so response delivery on cold start
// can be captured independently of Tauri's later setup/webview readiness.
extern "C" void agentport_push_prepare(void) {
    notificationDelegate = [AgentPortPushDelegate new];
    [UNUserNotificationCenter currentNotificationCenter].delegate = notificationDelegate;
    [[NSNotificationCenter defaultCenter] addObserverForName:UIApplicationWillEnterForegroundNotification
                                                  object:nil queue:nil usingBlock:^(NSNotification *note) {
        refreshPushRegistration();
    }];
}

static void didRegister(id self, SEL cmd, UIApplication *application, NSData *deviceToken) {
    const unsigned char *bytes = (const unsigned char *)deviceToken.bytes;
    NSMutableString *hex = [NSMutableString stringWithCapacity:deviceToken.length * 2];
    for (NSUInteger i = 0; i < deviceToken.length; i++) [hex appendFormat:@"%02x", bytes[i]];
    NSString *permission;
    @synchronized ([UIApplication class]) {
        pushToken = [hex copy];
        permission = pushPermission;
    }
    emitPush(@"mobile-push-token", @{ @"token": hex, @"permission": permission, @"environment": pushEnvironment });
}

static void didFailRegister(id self, SEL cmd, UIApplication *application, NSError *error) {
    @synchronized ([UIApplication class]) { pushToken = nil; }
    // Do not export potentially sensitive NSError text into a JS event.
    emitPush(@"mobile-push-token", @{ @"token": [NSNull null], @"permission": pushPermission, @"environment": pushEnvironment });
}

extern "C" void agentport_push_install(void (*callback)(const char *)) {
    @synchronized ([UIApplication class]) { pushCallback = callback; }
    // Tao owns UIApplicationDelegate. Add just the two APNs selectors to its
    // runtime class, without replacing its lifecycle/deep-link/scene handlers.
    id delegate = [UIApplication sharedApplication].delegate;
    if (!delegate) return;
    Class cls = object_getClass(delegate);
    class_addMethod(cls, @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:),
                    (IMP)didRegister, "v@:@@");
    class_addMethod(cls, @selector(application:didFailToRegisterForRemoteNotificationsWithError:),
                    (IMP)didFailRegister, "v@:@@");
    refreshPushRegistration();
}

extern "C" void agentport_push_request_authorization(void (*completion)(int)) {
    [[UNUserNotificationCenter currentNotificationCenter]
        requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
        completionHandler:^(BOOL granted, NSError *error) {
            if (error) { completion(-1); return; }
            [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
                updatePermission(settings.authorizationStatus);
                if (canRegister(settings.authorizationStatus)) {
                    dispatch_async(dispatch_get_main_queue(), ^{ [[UIApplication sharedApplication] registerForRemoteNotifications]; });
                }
                completion((int)settings.authorizationStatus);
            }];
        }];
}

// Caller owns returned C string (free). Keep a tap until JS has verified
// the host/session and explicitly acknowledged it; a webview reload must not
// discard a cold-start notification.
extern "C" char *agentport_push_take_state(void) {
    NSDictionary *state;
    @synchronized ([UIApplication class]) {
        state = @{ @"token": pushToken ?: (id)[NSNull null],
                   @"permission": pushPermission,
                   @"environment": pushEnvironment,
                   @"pendingTap": pendingTap ?: (id)[NSNull null] };
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return json ? strdup(json.UTF8String) : NULL;
}

extern "C" void agentport_push_ack_tap(const char *hostId, const char *sessionId) {
    if (!hostId || !sessionId) return;
    NSString *host = [NSString stringWithUTF8String:hostId];
    NSString *session = [NSString stringWithUTF8String:sessionId];
    @synchronized ([UIApplication class]) {
        if ([pendingTap[@"hostId"] isEqualToString:host] &&
            [pendingTap[@"sessionId"] isEqualToString:session]) pendingTap = nil;
    }
}
