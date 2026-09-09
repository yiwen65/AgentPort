# TestFlight distribution

App Store Connect display name: **AgentPorts**. Bundle ID remains
`com.agentport.mobile`; the installed app name is unchanged.

## Verified upload (2026-09-09)

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
