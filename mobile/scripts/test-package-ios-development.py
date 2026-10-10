#!/usr/bin/env python3
"""Portable profile-policy tests; no Xcode, credentials or device required."""
import copy
import datetime as dt
import importlib.util
import plistlib
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("packager", Path(__file__).with_name("package-ios-development.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2030, 1, 1, tzinfo=dt.timezone.utc)
        self.ent = {"get-task-allow": True, "application-identifier": "TESTPREFIX.com.example.test",
                    "com.apple.developer.team-identifier": "TESTTEAM00"}
        self.profile = {"CreationDate": self.now - dt.timedelta(days=1),
                        "ExpirationDate": self.now + dt.timedelta(days=6),
                        "TeamIdentifier": ["TESTTEAM00"], "ApplicationIdentifierPrefix": ["TESTPREFIX"],
                        "ProvisionedDevices": ["fake-device"], "DeveloperCertificates": [b"fake-cert"],
                        "Entitlements": copy.deepcopy(self.ent)}
        self.info = {"CFBundleIdentifier": "com.example.test", "CFBundleSupportedPlatforms": ["iPhoneOS"],
                     "DTPlatformName": "iphoneos"}

    def validate(self):
        return p.validate_profile(self.profile, self.info, self.ent, "TESTTEAM00", "com.example.test",
                                  ["fake-device"], self.now)

    def test_valid_and_manifest_privacy(self):
        result = self.validate()
        self.assertEqual(result["provisioned_device_count"], 1)
        self.assertNotIn("TESTTEAM00", str(result))
        self.assertNotIn("fake-device", str(result))

    def test_naive_apple_dates(self):
        for key in ("CreationDate", "ExpirationDate"):
            self.profile[key] = self.profile[key].replace(tzinfo=None)
        self.validate()

    def test_profile_rejections(self):
        for key, value in [("ExpirationDate", self.now), ("ExpirationDate", self.now + dt.timedelta(minutes=30)),
                           ("CreationDate", self.now + dt.timedelta(days=1)), ("ExpirationDate", None),
                           ("TeamIdentifier", ["OTHER"]), ("ProvisionedDevices", []),
                           ("ProvisionedDevices", ["other-device"]), ("ProvisionsAllDevices", True),
                           ("ApplicationIdentifierPrefix", ["OTHER"]), ("DeveloperCertificates", [])]:
            with self.subTest(key=key, value=value):
                old = copy.deepcopy(self.profile)
                self.profile[key] = value
                with self.assertRaises(p.ValidationError):
                    self.validate()
                self.profile = old

    def test_distribution_and_entitlement_escalation(self):
        for target in (self.profile["Entitlements"], self.ent):
            target["get-task-allow"] = False
            with self.assertRaises(p.ValidationError):
                self.validate()
            target["get-task-allow"] = True
        self.ent["ungranted-capability"] = True
        with self.assertRaises(p.ValidationError):
            self.validate()

    def test_bundle_platform_and_signature_identity(self):
        for key, value in [("CFBundleIdentifier", "wrong"), ("DTPlatformName", "iphonesimulator"),
                           ("CFBundleSupportedPlatforms", ["iPhoneSimulator"])]:
            old = self.info[key]
            self.info[key] = value
            with self.assertRaises(p.ValidationError):
                self.validate()
            self.info[key] = old
        for key in ("application-identifier", "com.apple.developer.team-identifier"):
            old = self.ent[key]
            self.ent[key] = "wrong"
            with self.assertRaises(p.ValidationError):
                self.validate()
            self.ent[key] = old

    def test_wildcard_grants(self):
        self.profile["Entitlements"]["application-identifier"] = "TESTPREFIX.*"
        self.validate()
        self.assertTrue(p.allowed(["TESTPREFIX.group"], ["TESTPREFIX.*"]))
        self.assertFalse(p.allowed(["OTHER.group"], ["TESTPREFIX.*"]))
        self.assertFalse(p.allowed(True, 1))


class SceneManifestTests(unittest.TestCase):
    def scene_info(self):
        root = Path(__file__).resolve().parents[1] / "src-tauri"
        info = plistlib.loads((root / "Info.ios.plist").read_bytes())
        info["DTSDKName"] = "iphoneos27.0"
        return info

    def test_sdk27_requires_complete_tao_scene_configuration(self):
        p.validate_scene_manifest(self.scene_info())
        for manifest in [None, {}, {"UIApplicationSupportsMultipleScenes": True},
                         {"UIApplicationSupportsMultipleScenes": True, "UISceneConfigurations": {}},
                         {"UIApplicationSupportsMultipleScenes": True, "UISceneConfigurations": {
                             "UIWindowSceneSessionRoleApplication": []}}]:
            with self.subTest(manifest=manifest):
                info = self.scene_info()
                info["UIApplicationSceneManifest"] = manifest
                with self.assertRaises(p.ValidationError):
                    p.validate_scene_manifest(info)

    def test_rejects_false_untyped_boolean_or_wrong_delegate(self):
        for value in (False, 1, "true"):
            info = self.scene_info()
            info["UIApplicationSceneManifest"]["UIApplicationSupportsMultipleScenes"] = value
            with self.subTest(value=value), self.assertRaises(p.ValidationError):
                p.validate_scene_manifest(info)
        for field, value in (("UISceneDelegateClassName", "WrongDelegate"), ("UISceneConfigurationName", "")):
            info = self.scene_info()
            scene = info["UIApplicationSceneManifest"]["UISceneConfigurations"]["UIWindowSceneSessionRoleApplication"][0]
            scene[field] = value
            with self.subTest(field=field), self.assertRaises(p.ValidationError):
                p.validate_scene_manifest(info)

    def test_legacy_archive_is_supported_but_unknown_sdk_is_not(self):
        p.validate_scene_manifest({"DTSDKName": "iphoneos26.5"})
        for sdk in (None, "iphonesimulator27.0", "unknown"):
            with self.subTest(sdk=sdk), self.assertRaises(p.ValidationError):
                p.validate_scene_manifest({"DTSDKName": sdk})

    def test_canonical_and_generated_scene_manifest_match_tao_runtime(self):
        root = Path(__file__).resolve().parents[1] / "src-tauri"
        for relative in ("Info.ios.plist", "gen/apple/agentport-mobile_iOS/Info.plist"):
            with self.subTest(path=relative):
                info = plistlib.loads((root / relative).read_bytes())
                manifest = info.get("UIApplicationSceneManifest")
                self.assertIsInstance(manifest, dict)
                # Tao 0.35 requires this true boolean for delegate registration,
                # deferred app readiness and attaching windows to their scene.
                self.assertIs(manifest.get("UIApplicationSupportsMultipleScenes"), True)
                configs = manifest.get("UISceneConfigurations", {}).get("UIWindowSceneSessionRoleApplication", [])
                self.assertEqual(len(configs), 1)
                self.assertEqual(configs[0].get("UISceneConfigurationName"), "TaoScene")
                self.assertEqual(configs[0].get("UISceneDelegateClassName"), "TaoSceneDelegate")


if __name__ == "__main__":
    unittest.main()
