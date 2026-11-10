"""Beneficiary card generation.

Produces an HTML card for an approved beneficiary, suitable for printing
or PDF conversion. Includes a QR code encoding the beneficiary ID.
"""
import base64
import io
import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)


def _qr_data_uri(text: str) -> str:
    try:
        import qrcode
        img = qrcode.make(text, box_size=4, border=2)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        return f"data:image/png;base64,{b64}"
    except ImportError:
        return ""


def generate_card_html(beneficiary: Dict[str, Any], btype: Dict[str, Any]) -> str:
    """Return a standalone HTML card for one approved beneficiary."""
    bid = beneficiary["beneficiary_id"]
    data = beneficiary.get("data") or {}
    type_name = btype.get("name", beneficiary.get("type_id", ""))
    master_fields = btype.get("master_fields") or []
    card_config = btype.get("card_config") or {}

    color = card_config.get("color", "#1e7a46")
    title_field = card_config.get("title_field", "")
    card_fields = card_config.get("fields") or master_fields or sorted(data.keys())
    show_qr = card_config.get("show_qr", True)
    org_name = _esc(card_config.get("org_name", ""))

    title_value = ""
    if title_field and title_field in data:
        title_value = _esc(str(data[title_field]))

    qr_src = _qr_data_uri(bid) if show_qr else ""

    field_rows = ""
    for key in card_fields:
        if key == title_field:
            continue
        val = data.get(key, "")
        if val is None or val == "":
            continue
        label = key.replace("_", " ").title()
        field_rows += f"""
        <tr>
          <td style="padding:4px 12px 4px 0;font-weight:600;color:#555;
                     font-size:11px;text-transform:uppercase;letter-spacing:0.5px;
                     white-space:nowrap;vertical-align:top">{label}</td>
          <td style="padding:4px 0;font-size:13px;color:#222">{_esc(str(val))}</td>
        </tr>"""

    qr_block = ""
    if qr_src:
        qr_block = f'<img src="{qr_src}" width="80" height="80" style="display:block" />'
    elif show_qr:
        qr_block = '<div style="width:80px;height:80px;background:#eee;display:flex;align-items:center;justify-content:center;font-size:10px;color:#999;border-radius:4px">QR</div>'

    org_line = ""
    if org_name:
        org_line = f'<div style="font-size:9px;text-transform:uppercase;letter-spacing:2px;opacity:0.75;margin-bottom:2px">{org_name}</div>'

    title_line = ""
    if title_value:
        title_line = f'<div style="font-size:16px;font-weight:700;margin-top:8px">{title_value}</div>'

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Beneficiary Card - {_esc(bid)}</title>
<style>
  @media print {{
    body {{ margin: 0; }}
    .card {{ box-shadow: none !important; border: 1px solid #ccc !important; }}
  }}
  body {{ font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; margin: 20px; }}
</style>
</head>
<body>
<div class="card" style="max-width:420px;margin:0 auto;background:#fff;border-radius:12px;
     box-shadow:0 2px 12px rgba(0,0,0,0.1);overflow:hidden">
  <div style="background:linear-gradient(135deg,{color},{_lighten(color)});padding:16px 20px;color:#fff">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        {org_line}
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:1.5px;opacity:0.85">
          Beneficiary Card</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">{_esc(type_name)}</div>
      </div>
      {qr_block}
    </div>
  </div>
  <div style="padding:20px">
    <div style="font-size:13px;color:#888;margin-bottom:4px">Beneficiary ID</div>
    <div style="font-size:20px;font-weight:700;color:{color};letter-spacing:1px;
                margin-bottom:4px;font-family:monospace">{_esc(bid)}</div>
    {title_line}
    <table style="border-collapse:collapse;width:100%;margin-top:12px">
      {field_rows}
    </table>
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid #eee;
                display:flex;justify-content:space-between;font-size:10px;color:#aaa">
      <span>Issued: {beneficiary.get('reviewed_on', beneficiary.get('created_on', ''))}</span>
      <span>Status: APPROVED</span>
    </div>
  </div>
</div>
</body>
</html>"""


def _esc(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))


def _lighten(hex_color: str) -> str:
    """Lighten a hex color slightly for gradient end."""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return "#4db877"
    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        r = min(255, r + 40)
        g = min(255, g + 40)
        b = min(255, b + 30)
        return f"#{r:02x}{g:02x}{b:02x}"
    except ValueError:
        return "#4db877"
