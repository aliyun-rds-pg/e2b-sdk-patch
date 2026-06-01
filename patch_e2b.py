"""Patch e2b library to customize sandbox URLs for Kruise integration.

Compatibility
-------------
Tested against e2b 2.25.1 + e2b-code-interpreter 2.7.0.

The patch is structured to degrade gracefully on adjacent SDK versions:

* **Attributes captured via ``getattr(..., None)``** (``validate_api_key``,
  ``get_host``, ``get_sandbox_url``, ``_jupyter_url``) — if missing on the
  installed SDK, the corresponding swap is silently skipped. So a pre-2.25.x
  SDK without ``e2b.api.validate_api_key`` works fine; the URL-routing
  patches still apply and the validator bypass is a no-op (there's nothing
  to bypass).

* **Imports at the top of this module are hard requirements**: ``e2b``,
  ``e2b.api``, ``e2b.sandbox.main``, and ``e2b_code_interpreter`` must be
  importable. SDK versions that restructure these module paths will fail at
  import time — adapt the imports if you target such a version.
"""

import os
from typing import Any

import e2b.api
from e2b import ConnectionConfig
from e2b.sandbox.main import SandboxBase
from e2b_code_interpreter.code_interpreter_sync import JUPYTER_PORT
from e2b_code_interpreter.code_interpreter_sync import Sandbox as SandboxSync

# Constants
_E2B_DOMAIN_ENV = "E2B_DOMAIN"
_E2B_API_URL_ENV = "E2B_API_URL"

# Originals captured at import time for unpatch_e2b(). Each is read
# defensively via ``getattr(..., None)`` so the module imports cleanly even
# on older e2b SDKs that lack one of these attributes (most notably
# ``e2b.api.validate_api_key``, which only exists from 2.25.x onward).
# A ``None`` entry means "this SDK version doesn't have it" — patch_e2b()
# and unpatch_e2b() skip the corresponding swap in that case.
_ORIGINAL_SANDBOX_GET_HOST = getattr(SandboxBase, "get_host", None)
_ORIGINAL_CC_GET_HOST = getattr(ConnectionConfig, "get_host", None)
_ORIGINAL_CC_GET_SANDBOX_URL = getattr(ConnectionConfig, "get_sandbox_url", None)
_ORIGINAL_VALIDATE_API_KEY = getattr(e2b.api, "validate_api_key", None)
_ORIGINAL_JUPYTER_URL_DESCRIPTOR = SandboxSync.__dict__.get("_jupyter_url")

# Holds the E2B_API_URL value that existed before patch_e2b() last ran, so
# unpatch_e2b() can restore it instead of unconditionally deleting it. The
# ``_UNSET`` sentinel stored in ``_PRE_PATCH_E2B_API_URL`` means the env var
# was originally absent; a string means restore that exact value. The
# separate ``_PRE_PATCH_CAPTURED`` flag distinguishes "not captured yet"
# from "captured-as-unset" — without it, a second patch_e2b() call would
# overwrite the saved value with the already-patched URL.
_UNSET = object()
_PRE_PATCH_E2B_API_URL: Any = _UNSET
_PRE_PATCH_CAPTURED: bool = False


def _get_e2b_domain() -> str:
    """Get E2B_DOMAIN from environment variables.

    Returns:
        The E2B domain string.

    Raises:
        EnvironmentError: If E2B_DOMAIN is not set.
    """
    domain = os.environ.get(_E2B_DOMAIN_ENV)
    if not domain:
        raise EnvironmentError(
            f"Environment variable '{_E2B_DOMAIN_ENV}' is not set. "
            "Please set it before calling patch_e2b()."
        )
    return domain


def _sandbox_get_host(self: SandboxBase, port: int) -> str:
    """Custom host getter for SandboxBase."""
    return f"{_get_e2b_domain()}/kruise/{self.sandbox_id}/{port}"


def _connection_config_get_host(
    self: Any, sandbox_id: str, sandbox_domain: str, port: int
) -> str:
    """Custom host getter for ConnectionConfig."""
    return f"{_get_e2b_domain()}/kruise/{sandbox_id}/{port}"


def _get_api_url(https: bool) -> str:
    """Generate the API URL based on protocol."""
    protocol = "https" if https else "http"
    return f"{protocol}://{_get_e2b_domain()}/kruise/api"


def _connection_config_get_sandbox_url_http(
    self: Any, sandbox_id: str, sandbox_domain: str
) -> str:
    """Custom sandbox URL getter for HTTP connections."""
    host = _connection_config_get_host(
        self, sandbox_id, sandbox_domain, ConnectionConfig.envd_port
    )
    return f"http://{host}"


def _jupyter_url_http(self: SandboxSync) -> str:
    """Custom Jupyter URL property for HTTP connections."""
    return f"http://{_sandbox_get_host(self, JUPYTER_PORT)}"


def _noop_validate_api_key(api_key: str) -> None:
    """Skip the upstream ``e2b_<hex>`` format check so Kruise-issued keys work."""
    return None


def patch_e2b(https: bool = True) -> None:
    """Patch e2b library to use custom Kruise URLs.

    This function modifies the e2b library's URL generation methods to route
    traffic through the Kruise proxy.

    Side effects (all reversible via ``unpatch_e2b()``):
      - ``SandboxBase.get_host`` and ``ConnectionConfig.get_host`` are swapped
        for Kruise-aware variants.
      - ``e2b.api.validate_api_key`` is replaced with a no-op so non-conforming
        keys (e.g. Kruise-issued ``sm-...``) are not rejected.
      - The ``E2B_API_URL`` environment variable is set to the Kruise API URL;
        its prior value (if any) is captured for restoration.
      - When ``https=False``: ``ConnectionConfig.get_sandbox_url`` and
        ``SandboxSync._jupyter_url`` (the ``Sandbox`` class from
        ``e2b_code_interpreter.code_interpreter_sync``) are also swapped for
        HTTP variants.

    Args:
        https: If True, use HTTPS protocol; otherwise use HTTP.

    Raises:
        EnvironmentError: If E2B_DOMAIN environment variable is not set.

    Example:
        >>> os.environ['E2B_DOMAIN'] = 'example.com'
        >>> patch_e2b(https=True)
    """
    # Validate E2B_DOMAIN is set before patching
    _get_e2b_domain()

    global _PRE_PATCH_E2B_API_URL, _PRE_PATCH_CAPTURED
    if not _PRE_PATCH_CAPTURED:
        _PRE_PATCH_E2B_API_URL = os.environ.get(_E2B_API_URL_ENV, _UNSET)
        _PRE_PATCH_CAPTURED = True

    os.environ[_E2B_API_URL_ENV] = _get_api_url(https)
    if _ORIGINAL_SANDBOX_GET_HOST is not None:
        SandboxBase.get_host = _sandbox_get_host
    if _ORIGINAL_CC_GET_HOST is not None:
        ConnectionConfig.get_host = _connection_config_get_host
    # Only bypass the validator if upstream actually has one (2.25.x+);
    # older SDKs don't validate, so there's nothing to disable.
    if _ORIGINAL_VALIDATE_API_KEY is not None:
        e2b.api.validate_api_key = _noop_validate_api_key

    if not https:
        if _ORIGINAL_CC_GET_SANDBOX_URL is not None:
            ConnectionConfig.get_sandbox_url = _connection_config_get_sandbox_url_http
        setattr(SandboxSync, "_jupyter_url", property(_jupyter_url_http))


def unpatch_e2b() -> None:
    """Restore e2b library methods replaced by ``patch_e2b()``.

    Symmetric reversal: restores the original ``get_host``,
    ``get_sandbox_url``, ``validate_api_key``, and ``_jupyter_url`` bindings.
    Also restores ``E2B_API_URL`` to its pre-patch value — or clears it if
    the env var was originally unset.

    If ``patch_e2b()`` was never called, this is a full no-op: the function
    will not touch any prototype methods, the validator, or the env var, so
    user-installed monkey-patches on the e2b SDK are left undisturbed.
    """
    global _PRE_PATCH_E2B_API_URL, _PRE_PATCH_CAPTURED
    if not _PRE_PATCH_CAPTURED:
        return

    if _ORIGINAL_SANDBOX_GET_HOST is not None:
        SandboxBase.get_host = _ORIGINAL_SANDBOX_GET_HOST
    if _ORIGINAL_CC_GET_HOST is not None:
        ConnectionConfig.get_host = _ORIGINAL_CC_GET_HOST
    if _ORIGINAL_CC_GET_SANDBOX_URL is not None:
        ConnectionConfig.get_sandbox_url = _ORIGINAL_CC_GET_SANDBOX_URL
    if _ORIGINAL_VALIDATE_API_KEY is not None:
        e2b.api.validate_api_key = _ORIGINAL_VALIDATE_API_KEY

    if _ORIGINAL_JUPYTER_URL_DESCRIPTOR is None:
        if "_jupyter_url" in SandboxSync.__dict__:
            delattr(SandboxSync, "_jupyter_url")
    else:
        setattr(SandboxSync, "_jupyter_url", _ORIGINAL_JUPYTER_URL_DESCRIPTOR)

    if _PRE_PATCH_E2B_API_URL is _UNSET:
        os.environ.pop(_E2B_API_URL_ENV, None)
    else:
        os.environ[_E2B_API_URL_ENV] = _PRE_PATCH_E2B_API_URL
    _PRE_PATCH_E2B_API_URL = _UNSET
    _PRE_PATCH_CAPTURED = False
