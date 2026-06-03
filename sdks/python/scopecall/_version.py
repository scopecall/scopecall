"""Single source of truth for the SDK version.

Bumped in lockstep with pyproject.toml. Surfaced on every emitted event
as `sdk_version` so the dashboard can report per-SDK adoption.
"""

__version__ = "0.2.0"
