#!/usr/bin/env python3
"""Portable profile-policy tests; no Xcode, credentials or device required."""
import copy
import datetime as dt
import importlib.util
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


if __name__ == "__main__":
    unittest.main()
