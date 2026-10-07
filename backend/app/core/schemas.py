"""Request models for signing in, accounts and roles."""
from typing import List, Optional

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    # Whatever was typed into the first box: an email address, a username or a
    # phone number. Still called `email` because every existing caller and the
    # mobile contract send that name.
    email: str
    password: str


class VoiceLoginRequest(BaseModel):
    """Signing in by speaking.

    One recording, base64 of 16 kHz mono 16-bit PCM — the same format enrolment
    uses, and audio rather than a voiceprint for the same reason: a client that
    could send a vector could send the one it had just read off somebody else's
    account.
    """
    # Still `email`, like LoginRequest: whatever was typed into the first box.
    email: str
    recording: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8)


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    password: str = Field(..., min_length=8)


class CreateUserRequest(BaseModel):
    # Any one of the three identifies the account; at least one is required,
    # which `create_user` enforces so the message says what is missing.
    email: Optional[str] = None
    password: str = Field(..., min_length=8)
    # Extra ways to sign in to the same account. Optional: an account with
    # neither signs in by email, as every account did before these existed.
    username: Optional[str] = Field(default=None, max_length=50)
    phone: Optional[str] = Field(default=None, max_length=20)
    full_name: Optional[str] = Field(default=None, max_length=120)
    # A role id or a role name.
    role: str = "field"


class CreateRoleRequest(BaseModel):
    label: str = Field(..., min_length=1, max_length=80)
    # Defaults to a slug of the label.
    name: Optional[str] = Field(default=None, max_length=50)
    description: Optional[str] = None
    permissions: List[str] = Field(default_factory=list)


class UpdateRoleRequest(BaseModel):
    label: Optional[str] = Field(default=None, max_length=80)
    description: Optional[str] = None
    # Omit to leave the permissions alone; send a list to replace them.
    permissions: Optional[List[str]] = None


class DeleteRoleRequest(BaseModel):
    # Where to move anyone still holding the role.
    reassign_to: Optional[str] = None


class EnrolVoiceRequest(BaseModel):
    """Recordings of one person, to become the voiceprint on their account.

    Each is base64 of 16 kHz mono signed 16-bit PCM — audio, deliberately, and
    never a computed vector: a client trusted to send a vector could send
    somebody else's and enrol their voice onto this account.

    The count is bounded here rather than only in the service so an oversized
    body is refused before it is parsed.
    """
    recordings: List[str] = Field(..., min_length=3, max_length=5)
    # Required, and `false` is refused. Recording somebody's voice needs their
    # agreement, and the date it was given is stored with the voiceprint.
    consent: bool = False


class UpdateUserRequest(BaseModel):
    role: Optional[str] = None
    full_name: Optional[str] = Field(default=None, max_length=120)
    is_active: Optional[bool] = None
    # Clear a lockout after too many failed sign-in attempts.
    unlock: bool = False
