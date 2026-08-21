"""Request models for signing in, accounts and roles."""
from typing import List, Optional

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    email: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8)


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    password: str = Field(..., min_length=8)


class CreateUserRequest(BaseModel):
    email: str
    password: str = Field(..., min_length=8)
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


class UpdateUserRequest(BaseModel):
    role: Optional[str] = None
    full_name: Optional[str] = Field(default=None, max_length=120)
    is_active: Optional[bool] = None
    # Clear a lockout after too many failed sign-in attempts.
    unlock: bool = False
