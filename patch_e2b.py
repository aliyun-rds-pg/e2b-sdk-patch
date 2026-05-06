"""Patch e2b library to customize sandbox URLs for Kruise integration."""

import os
from typing import Any

from e2b import ConnectionConfig
from e2b.sandbox.main import SandboxBase
from e2b_code_interpreter.code_interpreter_sync import JUPYTER_PORT
from e2b_code_interpreter.code_interpreter_sync import Sandbox as SandboxSync

# Constants
_E2B_DOMAIN_ENV = "E2B_DOMAIN"
_E2B_API_URL_ENV = "E2B_API_URL"


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


def patch_e2b(https: bool = True) -> None:
    """Patch e2b library to use custom Kruise URLs.

    This function modifies the e2b library's URL generation methods to route
    traffic through the Kruise proxy.

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

    os.environ[_E2B_API_URL_ENV] = _get_api_url(https)
    SandboxBase.get_host = _sandbox_get_host
    ConnectionConfig.get_host = _connection_config_get_host

    if not https:
        ConnectionConfig.get_sandbox_url = _connection_config_get_sandbox_url_http
        setattr(SandboxSync, "_jupyter_url", property(_jupyter_url_http))
