"""Pick / launch / reuse a Lambda instance."""

from __future__ import annotations

import logging
import time
from typing import Iterable, Optional

import requests

from ..config import LambdaConfig
from .client import LambdaApiError, LambdaCloudClient

log = logging.getLogger(__name__)


def provision(client: LambdaCloudClient, cfg: LambdaConfig) -> dict:
    """Return an `instance` dict (id, ip, status, ...). Reuses a tagged warm one when possible.

    `cfg.tag` is matched against the instance `name` field.
    """
    if cfg.reuse_running:
        for inst in client.list_instances():
            if inst.get("status") == "active" and inst.get("name", "").startswith(cfg.tag):
                log.info("reusing warm instance %s (%s)", inst.get("id"), inst.get("ip"))
                return inst

    candidate_types: list[str] = [cfg.instance_type, *cfg.fallback_instance_types]
    last_err: Optional[Exception] = None
    for itype in candidate_types:
        region = client.pick_region_with_capacity(itype, preferred_region=cfg.region)
        if not region:
            log.warning("no capacity for %s in any region", itype)
            continue
        ssh_key_names = _resolve_ssh_keys(client, cfg)
        try:
            log.info("launching %s in %s with key=%s", itype, region, ssh_key_names)
            ids = client.launch(
                region_name=region,
                instance_type_name=itype,
                ssh_key_names=ssh_key_names,
                name=cfg.tag,
            )
        except LambdaApiError as e:
            log.warning("launch failed for %s: %s", itype, e)
            last_err = e
            continue
        if not ids:
            continue
        return client.wait_until_active(ids[0], timeout_seconds=1200.0)
    raise RuntimeError(
        f"unable to launch any of {candidate_types}: {last_err}"
    )


def terminate(client: LambdaCloudClient, instance_id: str) -> None:
    for attempt in range(1, 4):
        try:
            client.terminate([instance_id])
            return
        except requests.exceptions.RequestException as e:
            log.warning(
                "terminate request failed for %s (attempt %d/3): %s",
                instance_id,
                attempt,
                e,
            )
            if attempt < 3:
                time.sleep(2.0 * attempt)
        except LambdaApiError as e:
            log.warning("terminate failed for %s: %s", instance_id, e)
            return


def _resolve_ssh_keys(client: LambdaCloudClient, cfg: LambdaConfig) -> list[str]:
    keys = client.list_ssh_keys()
    if cfg.ssh_key_name:
        match = [k for k in keys if k.get("name") == cfg.ssh_key_name]
        if not match:
            raise RuntimeError(
                f"SSH key {cfg.ssh_key_name!r} not registered with Lambda. "
                f"Available: {[k.get('name') for k in keys]}"
            )
        return [cfg.ssh_key_name]
    if not keys:
        raise RuntimeError(
            "No SSH keys registered with Lambda Cloud. Add one in the console "
            "or set LambdaConfig.ssh_key_name."
        )
    return [keys[0]["name"]]
