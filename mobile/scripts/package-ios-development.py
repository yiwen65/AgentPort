#!/usr/bin/env python3
"""Validate and wrap an existing device development .app; never re-sign it."""
import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import plistlib
import re
import subprocess
import tempfile
from pathlib import Path


class ValidationError(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise ValidationError(message)


def utc(value):
    require(isinstance(value, dt.datetime), "Profile date missing/invalid")
    return value.replace(tzinfo=dt.timezone.utc) if value.tzinfo is None else value.astimezone(dt.timezone.utc)


def allowed(value, grant):
    if isinstance(value, str) and isinstance(grant, str):
        return fnmatch.fnmatchcase(value, grant)
    if isinstance(value, list) and isinstance(grant, list):
        return all(any(allowed(v, g) for g in grant) for v in value)
    if isinstance(value, dict) and isinstance(grant, dict):
        return all(k in grant and allowed(v, grant[k]) for k, v in value.items())
    return type(value) is type(grant) and value == grant


def validate_profile(profile, info, entitlements, team, bundle, devices, now=None, min_hours=1):
    """Pure validation, usable without Apple tools. Returns only non-identifying metadata."""
    now = utc(now or dt.datetime.now(dt.timezone.utc))
    expiry = utc(profile.get("ExpirationDate"))
    require(utc(profile.get("CreationDate")) <= now, "Profile is not yet valid")
    require(expiry > now + dt.timedelta(hours=min_hours), "Profile expired or too close to expiry")
    require(profile.get("TeamIdentifier") == [team], "Profile team mismatch")
    require(not profile.get("ProvisionsAllDevices", False), "Enterprise profiles are not supported")
    registered = profile.get("ProvisionedDevices")
    require(isinstance(registered, list) and registered and all(isinstance(d, str) and d for d in registered),
            "A registered-device development profile is required")
    require(devices and set(devices).issubset(set(registered)), "Requested device not provisioned (use hardware UDID)")
    grants = profile.get("Entitlements", {})
    require(grants.get("get-task-allow") is True and entitlements.get("get-task-allow") is True,
            "Development signing required; distribution/Ad Hoc profiles are rejected")
    require(info.get("CFBundleIdentifier") == bundle, "App bundle ID mismatch")
    require(info.get("CFBundleSupportedPlatforms") == ["iPhoneOS"] and info.get("DTPlatformName") == "iphoneos",
            "Physical iPhoneOS app required, not simulator")
    require(entitlements.get("com.apple.developer.team-identifier") == team, "Signature team mismatch")
    prefixes = profile.get("ApplicationIdentifierPrefix", [])
    require(any(entitlements.get("application-identifier") == p + "." + bundle for p in prefixes),
            "Signed application identifier mismatch")
    require(grants.get("com.apple.developer.team-identifier") == team, "Profile entitlement team mismatch")
    require(all(k in grants and allowed(v, grants[k]) for k, v in entitlements.items()),
            "Signed entitlements exceed profile grants")
    require(profile.get("DeveloperCertificates"), "Profile has no development certificates")
    return {"profile_expires_utc": expiry.isoformat(), "provisioned_device_count": len(registered),
            "validated_device_count": len(set(devices)), "signing": "development", "platform": "iPhoneOS"}


def run(*args):
    # Do not echo tool output: it can contain local signing identifiers or UDIDs.
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(result.returncode == 0, f"{Path(args[0]).name} verification/packaging failed")
    return result.stdout


def validate_app(app, args, work):
    require(app.is_dir() and app.suffix == ".app", "Expected an existing .app directory")
    require(not list(app.rglob("*.appex")) and not (app / "Watch").exists(),
            "Extensions/Watch apps require separate profile validation and are not supported")
    profile_path = app / "embedded.mobileprovision"
    require(profile_path.is_file(), "Missing embedded.mobileprovision")
    profile = plistlib.loads(run("security", "cms", "-D", "-i", str(profile_path)))
    info = plistlib.loads((app / "Info.plist").read_bytes())
    run("codesign", "--verify", "--deep", "--strict", str(app))
    entitlements = plistlib.loads(run("codesign", "-d", "--entitlements", ":-", str(app)))
    metadata = validate_profile(profile, info, entitlements, args.team_id, args.bundle_id,
                                args.device_udid, min_hours=args.min_valid_hours)
    cert_prefix = str(work / "cert")
    run("codesign", "-d", "--extract-certificates=" + cert_prefix, str(app))
    require(Path(cert_prefix + "0").read_bytes() in profile["DeveloperCertificates"],
            "Signing certificate is not authorized by profile")
    executable = info.get("CFBundleExecutable", "")
    require(executable and Path(executable).name == executable, "Invalid executable name")
    binary = app / executable
    require(run("xcrun", "lipo", "-archs", str(binary)).decode().strip() == "arm64", "Expected device arm64 binary")
    build = run("xcrun", "vtool", "-show-build", str(binary)).decode()
    require(re.search(r"platform\s+IOS\b", build) is not None and "IOSSIMULATOR" not in build,
            "Mach-O must target physical iOS")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New private output directory (must not exist)")
    parser.add_argument("--team-id", required=True)
    parser.add_argument("--bundle-id", default="com.agentport.mobile")
    parser.add_argument("--device-udid", action="append", required=True, help="Hardware UDID, repeatable")
    parser.add_argument("--min-valid-hours", type=float, default=1)
    args = parser.parse_args()
    require(args.min_valid_hours >= 0, "Minimum validity must be nonnegative")
    require(not args.output.exists(), "Output directory already exists")
    with tempfile.TemporaryDirectory(prefix="agentport-ipa-") as tmp:
        work = Path(tmp)
        payload = work / "Payload"
        payload.mkdir()
        app = payload / args.app.name
        run("ditto", str(args.app.resolve()), str(app))
        metadata = validate_app(app, args, work)
        ipa = work / "AgentPort-development.ipa"
        run("ditto", "-c", "-k", "--keepParent", "--norsrc", str(payload), str(ipa))
        # Verify the actual zip round trip, including embedded profile and signature.
        unpacked = work / "unpacked"
        run("ditto", "-x", "-k", str(ipa), str(unpacked))
        restored = unpacked / "Payload" / app.name
        require((app / "embedded.mobileprovision").read_bytes() == (restored / "embedded.mobileprovision").read_bytes(),
                "Packaging changed provisioning profile")
        validate_app(restored, args, work)
        digest = hashlib.sha256(ipa.read_bytes()).hexdigest()
        metadata.update({"schema_version": 1, "artifact": ipa.name, "sha256": digest,
                         "created_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                         "signature_verified": True, "profile_preserved": True})
        args.output.mkdir(parents=True, mode=0o700)
        run("ditto", str(ipa), str(args.output / ipa.name))
        (args.output / "manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
        (args.output / "SHA256SUMS").write_text(f"{digest}  {ipa.name}\n")
    print("Validated development IPA, manifest.json and SHA256SUMS written.")


if __name__ == "__main__":
    try:
        main()
    except (ValidationError, OSError, plistlib.InvalidFileException) as exc:
        raise SystemExit(f"Packaging refused: {exc}")
