"""Thin client for the Lambda Cloud REST API.

Docs: https://cloud.lambda.ai/api/v1/docs
Auth: HTTP Basic with the API key as the username (empty password).
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

import requests

log = logging.getLogger(__name__)

BASE_URL = "https://cloud.lambda.ai/api/v1"


class LambdaApiError(RuntimeError):
    def __init__(self, status: int, body: Any):
        super().__init__(f"Lambda API {status}: {body}")
        self.status = status
        self.body = body


class LambdaCloudClient:
    def __init__(self, api_key: str, base_url: str = BASE_URL, timeout: float = 30.0):
        if not api_key:
            raise ValueError("Lambda Cloud API key is required.")
        self._session = requests.Session()
        self._session.auth = (api_key, "")
        self._base = base_url.rstrip("/")
        self._timeout = timeout

    # ---- generic ---------------------------------------------------------
    def _request(self, method: str, path: str, **kw: Any) -> Any:
        url = f"{self._base}{path}"
        resp = self._session.request(method, url, timeout=self._timeout, **kw)
        ctype = resp.headers.get("content-type", "")
        body = resp.json() if "json" in ctype else resp.text
        if resp.status_code >= 400:
            raise LambdaApiError(resp.status_code, body)
        return body.get("data", body) if isinstance(body, dict) else body

    # ---- endpoints -------------------------------------------------------
    def list_instance_types(self) -> dict[str, dict]:
        """Returns map of {instance_type_name: {instance_type, regions_with_capacity_available}}."""
        return self._request("GET", "/instance-types") or {}

    def list_instances(self) -> list[dict]:
        return self._request("GET", "/instances") or []

    def get_instance(self, instance_id: str) -> dict:
        return self._request("GET", f"/instances/{instance_id}")

    def list_ssh_keys(self) -> list[dict]:
        return self._request("GET", "/ssh-keys") or []

    def add_ssh_key(self, name: str, public_key: str) -> dict:
        return self._request("POST", "/ssh-keys", json={"name": name, "public_key": public_key})

    def launch(
        self,
        *,
        region_name: str,
        instance_type_name: str,
        ssh_key_names: list[str],
        name: Optional[str] = None,
        file_system_names: Optional[list[str]] = None,
    ) -> list[str]:
        payload: dict[str, Any] = {
            "region_name": region_name,
            "instance_type_name": instance_type_name,
            "ssh_key_names": ssh_key_names,
            "quantity": 1,
        }
        if name:
            payload["name"] = name
        if file_system_names:
            payload["file_system_names"] = file_system_names
        result = self._request("POST", "/instance-operations/launch", json=payload)
        return result.get("instance_ids", []) if isinstance(result, dict) else []

    def terminate(self, instance_ids: list[str]) -> Any:
        return self._request(
            "POST", "/instance-operations/terminate",
            json={"instance_ids": instance_ids},
        )

    # ---- helpers ---------------------------------------------------------
    def pick_region_with_capacity(
        self, instance_type: str, preferred_region: Optional[str] = None
    ) -> Optional[str]:
        types = self.list_instance_types()
        entry = types.get(instance_type)
        if not entry:
            return None
        regions = [r["name"] for r in entry.get("regions_with_capacity_available", [])]
        if preferred_region and preferred_region in regions:
            return preferred_region
        return regions[0] if regions else None

    def wait_until_active(
        self,
        instance_id: str,
        *,
        poll_seconds: float = 6.0,
        timeout_seconds: float = 600.0,
    ) -> dict:
        deadline = time.monotonic() + timeout_seconds
        last_status = None
        consecutive_errors = 0
        while time.monotonic() < deadline:
            try:
                inst = self.get_instance(instance_id)
                consecutive_errors = 0
            except (requests.exceptions.RequestException, LambdaApiError) as e:
                consecutive_errors += 1
                # Brief Lambda API hiccups are common; only fail after several in a row.
                if consecutive_errors >= 6:
                    raise
                log.warning("transient API error polling %s (#%d): %s",
                            instance_id, consecutive_errors, e)
                time.sleep(poll_seconds)
                continue
            status = inst.get("status")
            if status != last_status:
                log.info("instance %s status=%s ip=%s", instance_id, status, inst.get("ip"))
                last_status = status
            if status == "active" and inst.get("ip"):
                return inst
            if status in {"terminated", "terminating", "failed"}:
                raise LambdaApiError(409, f"instance entered {status}")
            time.sleep(poll_seconds)
        raise TimeoutError(f"instance {instance_id} did not become active in {timeout_seconds}s")
