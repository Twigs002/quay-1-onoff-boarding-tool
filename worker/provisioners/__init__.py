"""Browser provisioners for portals with no usable user-management API.

Each module exposes create(person) and deactivate(person) and honors
config.DRY_RUN (default on). Dispatch table keyed by the queue `system` value.
"""
from . import propdata, cma, dialfire

# system -> module exposing create(person)/deactivate(person)
REGISTRY = {
    "propdata": propdata,
    "cma": cma,
    "dialfire": dialfire,
}

__all__ = ["REGISTRY", "propdata", "cma", "dialfire"]
