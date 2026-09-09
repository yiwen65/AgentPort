#!/usr/bin/env python3
"""Local review-connector status/revocation. Never exposed by the HTTP portal."""
import argparse
import json
import os
import pwd
from review_gateway import ipc, private_path


def revoke_devices(call, public_keys=None):
    """Close enrollment before taking a fresh device snapshot, fencing a race."""
    before = call({"kind": "status"})["status"]
    pairing = before.get("pairing")
    if pairing and pairing["phase"] in ("waiting", "pending"):
        call({"kind": "close_invitation", "invitation_id": pairing["invitationId"]})
    current = call({"kind": "status"})["status"]
    targets = [device["publicKey"] for device in current["devices"]
               if public_keys is None or device["publicKey"] in public_keys]
    for key in targets:
        call({"kind": "revoke", "public_key": key})
    final = call({"kind": "status"})["status"]
    if any(device["publicKey"] in targets for device in final["devices"]):
        raise RuntimeError("Revocation did not persist; do not claim access is closed")
    return {"revoked": len(targets), "remainingDevices": len(final["devices"]),
            "activeChannels": final["activeChannels"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("command", choices=["status", "revoke-all"])
    args = parser.parse_args()
    if pwd.getpwuid(os.getuid()).pw_name != "agentportreview":
        raise SystemExit("Run only as agentportreview")
    config = json.loads(private_path(args.config).read_text())
    call = lambda request: ipc(config["socket_directory"], request)
    if args.command == "status":
        s = call({"kind": "status"})["status"]
        result = {"phase": s["phase"], "devices": len(s["devices"]),
                  "activeChannels": s["activeChannels"], "pairingPhase": (s.get("pairing") or {}).get("phase")}
    else:
        # The operator must first stop the gateway or remove its public route,
        # otherwise another authorized visitor could request a new invitation.
        result = revoke_devices(call)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
