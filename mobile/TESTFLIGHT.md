# TestFlight distribution

App Store Connect display name: **AgentsPort** (saved and verified after reload
on 2026-10-17). Bundle ID remains `com.agentport.mobile`. iOS builds beginning
with **1.0.0 (6)** configure `CFBundleDisplayName=AgentsPort`; the binary/product
name and existing credential identity remain unchanged. This does not rename
the desktop or Android app.

## Verified tester distribution (2026-09-11)

The user authorized distributing **0.1.0 (2)** to both existing groups, including
external beta review if required. At **02:52 CST**, App Store Connect confirmed:

- **external**: **Testing**, **1 tester**, **2 builds** including build 2.
- **agentport**: build 2 **Ready to Test**, **0 testers**, **2 builds**;
  this existing internal group uses automatic distribution for Xcode builds.
- The overall iOS build list showed build **2** as **Testing** in both groups.

The export-compliance gate was cleared after the user confirmed that the actual
distribution plan excludes France. The app uses standard cryptography beyond
Apple's system APIs; no encryption-exempt plist override was added. Updated
What to Test for the new recovery/session-menu behavior while preserving the
previous Linux review-access instructions; the saved 1,542-character value was
read back and compared exactly. The review portal's anonymous endpoint returned
HTTP 401. Submitted through **Submit for Review**, then verified **Testing** in
the external group rather than assuming submission meant tester availability.

No testers were added or removed, the existing public-link settings were not
changed, and build 1 remained available. Actual tester installation of build 2
and delivery of any email/push notification were not verified. No public App
Store release was submitted; existing Hosts and Agents were untouched.

## AgentsPort naming upload (2026-10-17)

The user confirmed **AgentsPort** for both the App Store and the iPhone/iPad
home-screen display name. The store name and the two mobile-brand references
in the English description were saved and read back after reload; references
to the separate desktop AgentPort project were preserved.

**1.0.0 (6)** was accepted by Apple's upload service at **23:05 CST**. Xcode
reported `Upload succeeded` / `EXPORT SUCCEEDED`; Public Browser showed its
Build Uploads row as **Processing** with the 23:05 upload time. Build 5 remains
in the existing history and was not deleted. Processing is not review approval.

The signed iPhoneOS/arm64 archive has `CFBundleDisplayName=AgentsPort`, unchanged
`com.agentport.mobile`, version 1.0.0 and build 6. Signature, Scene manifest,
no-static-library-resource and compiled new-icon checks passed. The display-name
regression first failed on the previous configuration, then the iOS packaging
suite passed 6/6; the full Mobile suite passed 949/949 and Python packaging 10/10.
Generated Xcode/schema files were restored to their pre-build state, preserving
the intentional new display-name settings. No desktop or Android rename occurred,
and this release archive was not installed over the user's current phone App.

The existing TestFlight review contact's four fields were copied to the blank
formal-review contact fields and matched exactly after reload. Existing formal
values were checked before writing; review login/password fields were not copied.
Policy publication, remaining declarations, screenshots and final review/release
permission are still governed by the task document linked below.

## App Store preparation upload (2026-10-17)

The user separately authorized preparing a new **1.0** App Store build, but not
submitting it for review or releasing it. Mobile version sources were aligned to
**1.0.0** (desktop remains 0.1.4), and **1.0.0 (5)** was accepted by Apple's upload
service at **22:49 CST**. Public Browser inspection confirmed **Version 1.0.0**,
**Build 5**, its upload time and **Missing Compliance**. This establishes upload
acceptance and arrival at the export-compliance gate, not review approval or
availability to users. No tester groups were changed.

Validation: the Release iPhoneOS archive is arm64, passes `codesign --verify
--deep --strict`, has the complete Tao Scene manifest, and contains no static
`.a` app resources. Its compiled iPhone/iPad icons match the new artwork already
verified on the physical iPhone. Generated Xcode files were backed up and
restored byte-for-byte; the previous development archive was preserved privately.
Xcode reported `Upload succeeded` / `EXPORT SUCCEEDED`. iOS packaging tests passed
5/5, the full Mobile suite 948/948, Python profile/Scene packaging tests 10/10,
and the icon generator verified all 34 mobile assets. The App Store version field was saved as 1.0.0 and read
back after reload.

Basic English store metadata and free pricing were saved. Region availability
was verified after reload: 148 available on release, the EU's 27 member states
not available. Privacy-policy draft `PRIVACY.md` is **not approved for public
publication**. Following the publisher's confirmation that users configure their
own Relay and the publisher does not collect user information, the App Privacy
questionnaire was saved as **Data Not Collected** and verified after reload; its
**Publish** action was not taken. Age/content-rights/encryption declarations,
review contact information, screenshots and final submission/release authorization
remain incomplete. The encryption dialog was inspected and cancelled without an
answer.
See `../docs/tasks/2026-10-17-ios-app-store-submission-task.md` for the authoritative
ongoing task status; do not infer public publication from this upload.

## Previous verified upload (2026-10-16)

Release **0.1.0 (3)**, built from source revision **a1a34e0**, was accepted by
Apple at **19:53 CST**. Xcode reported `Upload succeeded`, `EXPORT SUCCEEDED`
and `Uploaded package is processing`. Processing completion, export-compliance
status, external beta review and tester availability have not been verified.
No public App Store release or tester-group changes were submitted.

Validation: all **941 Mobile tests** passed on the full rerun (the first run had
one dashboard test failure; its isolated rerun also passed). The Release archive
passed `codesign --verify --deep --strict`, bundle/version checks and the no-static-
`.a`-resources guard. The initial archive failed because the active Rust toolchain
lacked `llvm-tools`, needed by the existing Swift symbol-export workaround on
Xcode 27. Installed that component, cleaned only the two affected Release plugin
packages and rebuilt successfully. Generated tracked files were backed up and
restored; existing Hosts, Agents and the desktop GUI were untouched.

## Previous verified upload (2026-09-11)

Release **0.1.0 (2)**, built from source revision **be4d486**, was uploaded
successfully at **02:37 CST**. Xcode reported `Upload succeeded` / `EXPORT
SUCCEEDED`; refreshing App Store Connect confirmed build **2** as **Processing**.
This is upload acceptance, not processing completion or tester availability.
No public App Store release, external-review submission, or tester-group change
was performed; the previous build **1** remained **Testing**.

Validation: all **424 Mobile tests** passed; the Release archive passed
`codesign --verify --deep --strict`, bundle/version checks, and contained no
static `.a` libraries. Existing generated Xcode/schema edits were backed up and
restored. Existing Hosts and Agents were not restarted. The first export failed
because Xcode could not find an account with App Store Connect access; after the
user verified the Xcode account, the same archive uploaded successfully.

## Previous verified upload (2026-09-09)

Release version **0.1.0**, build **1**, was accepted by Apple's upload service
and entered processing. Upload acceptance is not approval or tester availability.
Check the TestFlight tab for processing, export compliance and tester-group status.
Do not submit a public App Store release as part of this procedure.

## Static library packaging guard

Apple rejected the initial upload with error 90171 because `libapp.a` had been
copied into the app root by Xcode's Resources build phase. It must remain a link
input, not an app resource:

- `gen/apple/project.yml`: Externals uses `buildPhase: none`.
- The generated project has `libapp.a in Frameworks`, never `in Resources`.
- Clean the iOS build before archiving after fixing this: an old copied library
  can otherwise survive in build products.
- Check the archive contains no `.a` files and run `codesign --verify --deep
  --strict` on its app before export. Do not just delete a file from a signed IPA.

Regression: `npm test -- --run src/app/ios-packaging.test.ts` (from `mobile/`).
The test failed before the fix and passed after it. XcodeGen spec validation,
clean Release archive, signature check and Apple's upload validation passed.

## Build and upload

Use the current paid developer team's Xcode login and automatic signing. Keep
team IDs, provisioning profiles, credentials and generated signing changes local.
Preserve any pre-existing generated-file edits before Tauri builds. Build number
must be unused (or allow Xcode to manage it when uploading).

```sh
cd mobile
# APPLE_DEVELOPMENT_TEAM must be set locally.
npm run tauri -- ios build --target aarch64 --archive-only --ci \
  --config '{"bundle":{"iOS":{"bundleVersion":"1"}}}'
```

Export using a private ExportOptions plist with `method=app-store-connect`,
`destination=upload`, `signingStyle=automatic`, the local `teamID`, and
`manageAppVersionAndBuildNumber=true`; run `xcodebuild -exportArchive` with
`-allowProvisioningUpdates`. Use `destination=export` to obtain a local IPA
instead. The Personal Team packaging script in `RELEASE.md` is **not** a
TestFlight export path.

Do not declare encryption exempt merely to unblock processing: this app uses
SSH/Mosh cryptography as well as system APIs. Complete Apple's export-compliance
questions based on the actual implementation and applicable requirements.
