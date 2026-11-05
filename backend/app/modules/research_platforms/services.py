"""Services for Research Platforms & Long-Term Trials.

Pure JSONB operations, factorial design engine, protocol snapshotting,
and observation data pipelines.
"""

import io
import itertools
import json
import secrets
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from psycopg2.extras import Json

from app.core.database import transaction
from app.modules.research_platforms.s3_service import refresh_trial_media_urls
from app.modules.research_platforms.calculations import (
    aggregate_treatment_statistics,
    calculate_biomass,
    calculate_yield,
    compute_group_statistics,
)

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# ID Generation Helpers
# --------------------------------------------------------------------------- #
def _next_id(prefix: str, table_name: str, id_col: str) -> str:
    """Generate sequential IDs like PLT00001, TRL00001, CYC00001, etc."""
    with transaction() as cur:
        cur.execute(f"SELECT COUNT(*) AS c FROM {table_name}")
        row = cur.fetchone()
        count = (row["c"] if row else 0) + 1
        return f"{prefix}{count:05d}"


# --------------------------------------------------------------------------- #
# Factorial Design Engine (Treatments & Repeats Matrix)
# --------------------------------------------------------------------------- #
class FactorialDesignService:
    @staticmethod
    def generate_matrix(
        treatments_count: int = 0,
        replications_count: int = 3,
        subsamples_count: int = 0,
        factors: Optional[List[Dict[str, Any]]] = None,
        custom_treatments: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Generate treatment abbreviations and plot assignment matrix.

        factors: e.g. [
            {"name": "Tillage", "levels": ["Zero", "Conventional"]},
            {"name": "Residue", "levels": ["Retained", "Removed"]}
        ]
        """
        treatments = []
        if custom_treatments and len(custom_treatments) > 0:
            treatments = custom_treatments
        elif factors and len(factors) > 0:
            # Cartesian product of all factor levels
            factor_names = [f["name"] for f in factors]
            level_lists = [f.get("levels", []) for f in factors]
            combinations = list(itertools.product(*level_lists))

            for idx, combo in enumerate(combinations, start=1):
                # Auto-generate abbreviation: e.g. ZT-CR
                abbr_parts = [
                    "".join(word[0].upper() for word in str(lvl).split())[:4]
                    for lvl in combo
                ]
                abbr = "-".join(abbr_parts)
                factor_map = {factor_names[i]: combo[i] for i in range(len(combo))}
                treatments.append({
                    "id": idx,
                    "abbreviation": abbr,
                    "tillage": factor_map.get("Tillage", ""),
                    "crop_residue": factor_map.get("Residue", factor_map.get("Crop Residue", "")),
                    "factors": factor_map,
                })
        else:
            # Simple numbered treatments
            count = max(1, treatments_count)
            for idx in range(1, count + 1):
                treatments.append({
                    "id": idx,
                    "abbreviation": f"T{idx}",
                    "tillage": "Conventional" if idx % 2 == 0 else "Zero Tillage",
                    "crop_residue": "Retained" if idx % 2 != 0 else "Removed",
                    "factors": {},
                })

        # Generate Repeats & Plot Assignment rows
        repeats_table = []
        plot_seq = 101
        reps = max(1, replications_count)
        subsamples = max(0, subsamples_count)

        for t in treatments:
            t_id = t["id"]
            for rep in range(1, reps + 1):
                if subsamples > 0:
                    for s in range(1, subsamples + 1):
                        repeats_table.append({
                            "treatment_id": t_id,
                            "repeat_no": rep,
                            "subsample_no": s,
                            "plot_no": plot_seq,
                        })
                        plot_seq += 1
                else:
                    repeats_table.append({
                        "treatment_id": t_id,
                        "repeat_no": rep,
                        "subsample_no": 0,
                        "plot_no": plot_seq,
                    })
                    plot_seq += 1

        return {
            "treatments_count": len(treatments),
            "replications_count": reps,
            "subsamples_count": subsamples,
            "factors": factors or [],
            "treatments": treatments,
            "repeats_table": repeats_table,
        }


# --------------------------------------------------------------------------- #
# Platform Service
# --------------------------------------------------------------------------- #
class PlatformService:
    @staticmethod
    def list_platforms(search: Optional[str] = None, limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
        with transaction() as cur:
            query = """
                SELECT p.platform_id, p.name, p.payload, p.created_on, p.updated_on, p.created_by,
                       COUNT(t.trial_id) AS trials_count
                FROM research_platform p
                LEFT JOIN research_trial t ON p.platform_id = t.platform_id
            """
            params: List[Any] = []
            if search:
                query += " WHERE p.name ILIKE %s OR p.payload->>'abbreviation' ILIKE %s OR p.platform_id ILIKE %s "
                pattern = f"%{search.strip()}%"
                params.extend([pattern, pattern, pattern])

            query += " GROUP BY p.platform_id ORDER BY p.created_on DESC LIMIT %s OFFSET %s"
            params.extend([limit, offset])

            cur.execute(query, tuple(params))
            rows = cur.fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def get_platform(platform_id: str) -> Optional[Dict[str, Any]]:
        with transaction() as cur:
            cur.execute("""
                SELECT p.platform_id, p.name, p.payload, p.created_on, p.updated_on, p.created_by,
                       COUNT(t.trial_id) AS trials_count
                FROM research_platform p
                LEFT JOIN research_trial t ON p.platform_id = t.platform_id
                WHERE p.platform_id = %s
                GROUP BY p.platform_id
            """, (platform_id,))
            row = cur.fetchone()
            if not row:
                return None
            res = dict(row)
            # Fetch attached trials
            cur.execute("""
                SELECT trial_id, name, payload, created_on, created_by
                FROM research_trial WHERE platform_id = %s ORDER BY created_on ASC
            """, (platform_id,))
            res["trials"] = [dict(t) for t in cur.fetchall()]

            # Fetch cycles under all trials of this platform (Image 4 in Manual: Datos Generales del ciclo)
            cur.execute("""
                SELECT c.cycle_id, c.trial_id, c.year, c.season, c.payload, c.created_on, c.created_by,
                       t.name AS trial_name
                FROM research_cycle c
                JOIN research_trial t ON c.trial_id = t.trial_id
                WHERE t.platform_id = %s
                ORDER BY c.year DESC, c.season DESC
            """, (platform_id,))
            res["cycles"] = [dict(c) for c in cur.fetchall()]
            return res

    @staticmethod
    def create_platform(name: str, payload: Dict[str, Any], user_id: Optional[str] = None, platform_id: Optional[str] = None) -> Dict[str, Any]:
        clean_id = str(platform_id).strip() if platform_id and str(platform_id).strip() else None
        if clean_id:
            with transaction() as cur:
                cur.execute("SELECT 1 FROM research_platform WHERE platform_id = %s", (clean_id,))
                if cur.fetchone():
                    raise ValueError(f"Research Platform ID '{clean_id}' already exists. Please choose a unique ID or leave blank to auto-generate.")
            final_id = clean_id
        else:
            final_id = _next_id("PLT", "research_platform", "platform_id")
        now = datetime.utcnow()
        with transaction() as cur:
            cur.execute("""
                INSERT INTO research_platform (platform_id, name, payload, created_on, updated_on, created_by)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING platform_id, name, payload, created_on, updated_on, created_by
            """, (final_id, name, Json(payload), now, now, user_id or "system"))
            return dict(cur.fetchone())

    @staticmethod
    def update_platform(platform_id: str, name: str, payload: Dict[str, Any], user_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        now = datetime.utcnow()
        with transaction() as cur:
            cur.execute("""
                UPDATE research_platform
                SET name = %s, payload = %s, updated_on = %s
                WHERE platform_id = %s
                RETURNING platform_id, name, payload, created_on, updated_on, created_by
            """, (name, Json(payload), now, platform_id))
            row = cur.fetchone()
            return dict(row) if row else None

    @staticmethod
    def delete_platform(platform_id: str) -> bool:
        with transaction() as cur:
            cur.execute("DELETE FROM research_platform WHERE platform_id = %s", (platform_id,))
            return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# Trial Service
# --------------------------------------------------------------------------- #
class TrialService:
    @staticmethod
    def list_trials(
        platform_id: Optional[str] = None,
        independent_only: bool = False,
        search: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        with transaction() as cur:
            query = """
                SELECT t.trial_id, t.platform_id, t.name, t.payload, t.created_on, t.updated_on, t.created_by,
                       p.name AS platform_name,
                       COUNT(c.cycle_id) AS cycles_count
                FROM research_trial t
                LEFT JOIN research_platform p ON t.platform_id = p.platform_id
                LEFT JOIN research_cycle c ON t.trial_id = c.trial_id
            """
            conditions = []
            params: List[Any] = []

            if independent_only:
                conditions.append("t.platform_id IS NULL")
            elif platform_id:
                conditions.append("t.platform_id = %s")
                params.append(platform_id)

            if search:
                conditions.append("(t.name ILIKE %s OR t.payload->>'objective' ILIKE %s OR t.trial_id ILIKE %s)")
                params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])

            if conditions:
                query += " WHERE " + " AND ".join(conditions)

            query += " GROUP BY t.trial_id, p.name ORDER BY t.created_on DESC LIMIT %s OFFSET %s"
            params.extend([limit, offset])

            cur.execute(query, tuple(params))
            return [dict(r) for r in cur.fetchall()]

    @staticmethod
    def get_trial(trial_id: str) -> Optional[Dict[str, Any]]:
        with transaction() as cur:
            cur.execute("""
                SELECT t.trial_id, t.platform_id, t.name, t.payload, t.created_on, t.updated_on, t.created_by,
                       p.name AS platform_name, p.payload AS platform_payload
                FROM research_trial t
                LEFT JOIN research_platform p ON t.platform_id = p.platform_id
                WHERE t.trial_id = %s
            """, (trial_id,))
            row = cur.fetchone()
            if not row:
                return None
            res = dict(row)
            if res.get("payload"):
                res["payload"] = refresh_trial_media_urls(res["payload"])
            # Fetch cycles for this trial
            cur.execute("""
                SELECT c.cycle_id, c.year, c.season, c.payload, c.created_on,
                       pr.protocol_id
                FROM research_cycle c
                LEFT JOIN research_protocol pr ON c.cycle_id = pr.cycle_id
                WHERE c.trial_id = %s
                ORDER BY c.year DESC, c.season DESC
            """, (trial_id,))
            res["cycles"] = [dict(c) for c in cur.fetchall()]
            return res

    @staticmethod
    def create_trial(
        name: str,
        payload: Dict[str, Any],
        platform_id: Optional[str] = None,
        user_id: Optional[str] = None,
        trial_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        clean_id = str(trial_id).strip() if trial_id and str(trial_id).strip() else None
        if clean_id:
            with transaction() as cur:
                cur.execute("SELECT 1 FROM research_trial WHERE trial_id = %s", (clean_id,))
                if cur.fetchone():
                    raise ValueError(f"Trial ID '{clean_id}' already exists. Please choose a unique ID or leave blank to auto-generate.")
            final_id = clean_id
        else:
            final_id = _next_id("TRL", "research_trial", "trial_id")
        now = datetime.utcnow()

        # Ensure design is populated
        if "design" not in payload:
            payload["design"] = FactorialDesignService.generate_matrix(
                treatments_count=int(payload.get("treatments_count", 3)),
                replications_count=int(payload.get("replications_count", 3)),
                subsamples_count=int(payload.get("subsamples_count", 0)),
            )

        with transaction() as cur:
            cur.execute("""
                INSERT INTO research_trial (trial_id, platform_id, name, payload, created_on, updated_on, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING trial_id, platform_id, name, payload, created_on, updated_on, created_by
            """, (final_id, platform_id, name, Json(payload), now, now, user_id or "system"))
            return dict(cur.fetchone())

    @staticmethod
    def update_trial(
        trial_id: str,
        name: str,
        payload: Dict[str, Any],
        platform_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        now = datetime.utcnow()
        with transaction() as cur:
            cur.execute("""
                UPDATE research_trial
                SET name = %s, platform_id = %s, payload = %s, updated_on = %s
                WHERE trial_id = %s
                RETURNING trial_id, platform_id, name, payload, created_on, updated_on, created_by
            """, (name, platform_id, Json(payload), now, trial_id))
            row = cur.fetchone()
            return dict(row) if row else None

    @staticmethod
    def delete_trial(trial_id: str) -> bool:
        with transaction() as cur:
            cur.execute("DELETE FROM research_trial WHERE trial_id = %s", (trial_id,))
            return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# Cycle Service
# --------------------------------------------------------------------------- #
class CycleService:
    @staticmethod
    def list_cycles(trial_id: str) -> List[Dict[str, Any]]:
        with transaction() as cur:
            cur.execute("""
                SELECT c.cycle_id, c.trial_id, c.year, c.season, c.payload, c.created_on, c.updated_on, c.created_by,
                       p.protocol_id
                FROM research_cycle c
                LEFT JOIN research_protocol p ON c.cycle_id = p.cycle_id
                WHERE c.trial_id = %s
                ORDER BY c.year DESC, c.season DESC
            """, (trial_id,))
            return [dict(r) for r in cur.fetchall()]

    @staticmethod
    def get_cycle(cycle_id: str) -> Optional[Dict[str, Any]]:
        with transaction() as cur:
            cur.execute("""
                SELECT c.cycle_id, c.trial_id, c.year, c.season, c.payload, c.created_on, c.updated_on, c.created_by,
                       p.protocol_id, t.name AS trial_name, t.platform_id
                FROM research_cycle c
                LEFT JOIN research_protocol p ON c.cycle_id = p.cycle_id
                JOIN research_trial t ON c.trial_id = t.trial_id
                WHERE c.cycle_id = %s
            """, (cycle_id,))
            row = cur.fetchone()
            return dict(row) if row else None

    @staticmethod
    def create_cycle(
        trial_id: str,
        year: int,
        season: str,
        payload: Dict[str, Any],
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        cycle_id = _next_id("CYC", "research_cycle", "cycle_id")
        now = datetime.utcnow()
        with transaction() as cur:
            cur.execute("""
                INSERT INTO research_cycle (cycle_id, trial_id, year, season, payload, created_on, updated_on, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING cycle_id, trial_id, year, season, payload, created_on, updated_on, created_by
            """, (cycle_id, trial_id, int(year), season.strip(), Json(payload), now, now, user_id or "system"))
            return dict(cur.fetchone())

    @staticmethod
    def update_cycle(
        cycle_id: str,
        year: int,
        season: str,
        payload: Dict[str, Any],
        user_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        now = datetime.utcnow()
        with transaction() as cur:
            cur.execute("""
                UPDATE research_cycle
                SET year = %s, season = %s, payload = %s, updated_on = %s
                WHERE cycle_id = %s
                RETURNING cycle_id, trial_id, year, season, payload, created_on, updated_on, created_by
            """, (int(year), season.strip(), Json(payload), now, cycle_id))
            row = cur.fetchone()
            return dict(row) if row else None


# --------------------------------------------------------------------------- #
# Protocol Service (with Frozen Treatments Snapshot)
# --------------------------------------------------------------------------- #
class ProtocolService:
    @staticmethod
    def get_protocol_for_cycle(cycle_id: str) -> Optional[Dict[str, Any]]:
        with transaction() as cur:
            cur.execute("""
                SELECT protocol_id, cycle_id, payload, created_on, updated_on, created_by
                FROM research_protocol
                WHERE cycle_id = %s
            """, (cycle_id,))
            row = cur.fetchone()
            return dict(row) if row else None

    @staticmethod
    def get_protocol(protocol_id: str) -> Optional[Dict[str, Any]]:
        with transaction() as cur:
            cur.execute("""
                SELECT pr.protocol_id, pr.cycle_id, pr.payload, pr.created_on, pr.updated_on, pr.created_by,
                       c.year, c.season, c.trial_id, t.name AS trial_name, t.platform_id, p.name AS platform_name
                FROM research_protocol pr
                JOIN research_cycle c ON pr.cycle_id = c.cycle_id
                JOIN research_trial t ON c.trial_id = t.trial_id
                LEFT JOIN research_platform p ON t.platform_id = p.platform_id
                WHERE pr.protocol_id = %s
            """, (protocol_id,))
            row = cur.fetchone()
            return dict(row) if row else None

    @staticmethod
    def save_protocol(cycle_id: str, payload: Dict[str, Any], user_id: Optional[str] = None) -> Dict[str, Any]:
        """Create or update a protocol.

        Ensures the trial's experimental design (treatments and repeats table)
        is permanently snapshotted into `payload.frozen_treatments_snapshot`.
        """
        now = datetime.utcnow()
        with transaction() as cur:
            # Check if protocol exists
            cur.execute("SELECT protocol_id, payload FROM research_protocol WHERE cycle_id = %s", (cycle_id,))
            existing = cur.fetchone()

            # If no snapshot yet, inherit it from trial
            if not payload.get("frozen_treatments_snapshot"):
                cur.execute("""
                    SELECT t.payload->'design' AS trial_design
                    FROM research_cycle c
                    JOIN research_trial t ON c.trial_id = t.trial_id
                    WHERE c.cycle_id = %s
                """, (cycle_id,))
                t_row = cur.fetchone()
                if t_row and t_row.get("trial_design"):
                    payload["frozen_treatments_snapshot"] = t_row["trial_design"]
                elif existing and existing["payload"].get("frozen_treatments_snapshot"):
                    payload["frozen_treatments_snapshot"] = existing["payload"]["frozen_treatments_snapshot"]

            if existing:
                protocol_id = existing["protocol_id"]
                cur.execute("""
                    UPDATE research_protocol
                    SET payload = %s, updated_on = %s
                    WHERE protocol_id = %s
                    RETURNING protocol_id, cycle_id, payload, created_on, updated_on, created_by
                """, (Json(payload), now, protocol_id))
                return dict(cur.fetchone())
            else:
                protocol_id = _next_id("PRT", "research_protocol", "protocol_id")
                cur.execute("""
                    INSERT INTO research_protocol (protocol_id, cycle_id, payload, created_on, updated_on, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING protocol_id, cycle_id, payload, created_on, updated_on, created_by
                """, (protocol_id, cycle_id, Json(payload), now, now, user_id or "system"))
                return dict(cur.fetchone())


# --------------------------------------------------------------------------- #
# Observation Service (Operations, Plants, Yield, Biomass)
# --------------------------------------------------------------------------- #
class ObservationService:
    @staticmethod
    def list_observations(protocol_id: str, module_type: Optional[str] = None) -> List[Dict[str, Any]]:
        with transaction() as cur:
            query = """
                SELECT obs_id, protocol_id, module_type, payload, created_on, created_by
                FROM research_observation
                WHERE protocol_id = %s
            """
            params: List[Any] = [protocol_id]
            if module_type:
                query += " AND module_type = %s"
                params.append(module_type)

            query += " ORDER BY created_on ASC"
            cur.execute(query, tuple(params))
            return [dict(r) for r in cur.fetchall()]

    @staticmethod
    def create_observation(
        protocol_id: str,
        module_type: str,
        payload: Dict[str, Any],
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        obs_id = _next_id("OBS", "research_observation", "obs_id")
        now = datetime.utcnow()

        # Enforce automated calculations for yield and biomass
        raw = payload.get("raw_inputs", {})
        if module_type == "yield":
            computed = calculate_yield(
                area_m2=float(raw.get("harvest_area_m2") or payload.get("area_m2") or 24.0),
                grain_weight_kg=float(raw.get("gross_grain_weight_kg") or payload.get("grain_weight_kg") or 0.0),
                moisture_pct=float(raw.get("grain_moisture_percent") or payload.get("moisture_pct") or 14.0),
                standard_moisture_pct=float(payload.get("standard_moisture_pct") or 14.0),
                weight_1000_grains_g=float(raw.get("weight_1000_grains_g") or payload.get("weight_1000_grains_g") or 0.0) or None,
                weight_200g_sample_g=float(raw.get("sample_200g_weight") or payload.get("sample_200g_weight") or 0.0) or None,
            )
            payload["computed_results"] = computed
            payload["yield_tha"] = computed["yield_tha"]
        elif module_type == "biomass":
            computed = calculate_biomass(
                area_m2=float(raw.get("area_m2") or payload.get("area_m2") or 24.0),
                wet_weight_kg=float(raw.get("wet_weight_kg") or payload.get("wet_weight_kg") or 0.0),
                dry_weight_kg=float(raw.get("dry_weight_kg") or payload.get("dry_weight_kg") or 0.0) or None,
                moisture_pct=float(raw.get("moisture_pct") or payload.get("moisture_pct") or 0.0) or None,
            )
            payload["computed_results"] = computed
            payload["dry_yield_tha"] = computed["dry_yield_tha"]

        with transaction() as cur:
            cur.execute("""
                INSERT INTO research_observation (obs_id, protocol_id, module_type, payload, created_on, created_by)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING obs_id, protocol_id, module_type, payload, created_on, created_by
            """, (obs_id, protocol_id, module_type, Json(payload), now, user_id or "system"))
            return dict(cur.fetchone())

    @staticmethod
    def bulk_save_observations(
        protocol_id: str,
        module_type: str,
        observations: List[Dict[str, Any]],
        user_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        saved = []
        for item in observations:
            res = ObservationService.create_observation(protocol_id, module_type, item, user_id)
            saved.append(res)
        return saved

    @staticmethod
    def delete_observation(obs_id: str) -> bool:
        with transaction() as cur:
            cur.execute("DELETE FROM research_observation WHERE obs_id = %s", (obs_id,))
            return cur.rowcount > 0

    @staticmethod
    def get_protocol_statistics(protocol_id: str) -> Dict[str, Any]:
        """Compute treatment-wise statistical summaries for Yield and Biomass."""
        protocol = ProtocolService.get_protocol(protocol_id)
        if not protocol:
            return {}

        snapshot = protocol["payload"].get("frozen_treatments_snapshot", {})
        treatments = snapshot.get("treatments", [])
        treatments_map = {
            t["id"]: f"{t['id']} - {t.get('abbreviation', '')} ({t.get('tillage', '')})"
            for t in treatments
        }

        yield_obs = ObservationService.list_observations(protocol_id, "yield")
        biomass_obs = ObservationService.list_observations(protocol_id, "biomass")

        yield_stats = aggregate_treatment_statistics(yield_obs, "yield_tha", treatments_map)
        biomass_stats = aggregate_treatment_statistics(biomass_obs, "dry_yield_tha", treatments_map)

        return {
            "protocol_id": protocol_id,
            "yield_statistics": yield_stats,
            "biomass_statistics": biomass_stats,
        }


# --------------------------------------------------------------------------- #
# Multi-Sheet Excel Export Service
# --------------------------------------------------------------------------- #
class ResearchExportService:
    @staticmethod
    def export_trial_workbook(trial_id: str) -> io.BytesIO:
        """Export comprehensive trial history and data to Excel."""
        trial = TrialService.get_trial(trial_id)
        if not trial:
            raise ValueError(f"Trial {trial_id} not found")

        wb = openpyxl.Workbook()
        header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
        header_fill = PatternFill(start_color="1A5F3F", end_color="1A5F3F", fill_type="solid")
        border = Border(
            left=Side(style="thin", color="CCCCCC"),
            right=Side(style="thin", color="CCCCCC"),
            top=Side(style="thin", color="CCCCCC"),
            bottom=Side(style="thin", color="CCCCCC"),
        )

        def style_header(row):
            for cell in row:
                cell.font = header_font
                cell.fill = header_fill
                cell.alignment = Alignment(horizontal="center", vertical="center")
                cell.border = border

        # Sheet 1: Trial Overview
        ws1 = wb.active
        ws1.title = "Trial_Overview"
        ws1.append(["Field", "Value"])
        ws1.append(["Trial ID", trial["trial_id"]])
        ws1.append(["Trial Name", trial["name"]])
        ws1.append(["Platform Name", trial.get("platform_name") or "Independent"])
        ws1.append(["Objective", trial["payload"].get("objective", "")])
        ws1.append(["Created On", str(trial["created_on"])])
        style_header(ws1[1])

        # Sheet 2: Experimental Design & Treatments
        ws2 = wb.create_sheet(title="Treatments_Design")
        ws2.append(["Treatment ID", "Abbreviation", "Rotation Crops", "Tillage", "Residue Management", "Additional Factors"])
        design = trial["payload"].get("design", {})
        for t in design.get("treatments", []):
            rotation_str = ", ".join(t.get("rotation", [])) if isinstance(t.get("rotation"), list) else str(t.get("rotation") or "")
            ws2.append([
                t["id"],
                t.get("abbreviation", ""),
                rotation_str,
                t.get("tillage", ""),
                t.get("crop_residue", ""),
                json.dumps(t.get("factors", {})),
            ])
        style_header(ws2[1])

        # Sheet 3: Repeats & Plot Map
        ws3 = wb.create_sheet(title="Repeats_Plot_Map")
        ws3.append(["Treatment ID", "Repeat No", "Subsample No", "Plot No"])
        for r in design.get("repeats_table", []):
            ws3.append([r["treatment_id"], r["repeat_no"], r["subsample_no"], r["plot_no"]])
        style_header(ws3[1])

        # Sheet 4: Cycles Summary
        ws4 = wb.create_sheet(title="Historical_Cycles")
        ws4.append(["Cycle ID", "Year", "Season", "Main Crop", "Protocol ID", "Created On"])
        cycles = trial.get("cycles", [])
        for c in cycles:
            ws4.append([
                c["cycle_id"],
                c["year"],
                c["season"],
                c["payload"].get("main_crop", ""),
                c.get("protocol_id", "Not Created"),
                str(c["created_on"]),
            ])
        style_header(ws4[1])

        # Fetch observations for all protocols in this trial
        protocol_ids = [c["protocol_id"] for c in cycles if c.get("protocol_id")]
        all_obs = []
        if protocol_ids:
            with transaction() as cur:
                cur.execute("""
                    SELECT obs_id, protocol_id, module_type, payload, created_on
                    FROM research_observation
                    WHERE protocol_id = ANY(%s)
                    ORDER BY created_on ASC
                """, (protocol_ids,))
                all_obs = [dict(r) for r in cur.fetchall()]

        # Sheet 5: Yield Data
        ws5 = wb.create_sheet(title="Yield_Data")
        ws5.append(["Obs ID", "Protocol ID", "Plot No", "Treatment ID", "Harvest Area (m2)", "Grain Weight (kg)", "Moisture %", "Adjusted Yield (t/ha)", "Grains/m2"])
        for o in [x for x in all_obs if x["module_type"] == "yield"]:
            raw = o["payload"].get("raw_inputs", {})
            comp = o["payload"].get("computed_results", {})
            ws5.append([
                o["obs_id"],
                o["protocol_id"],
                o["payload"].get("plot_no"),
                o["payload"].get("treatment_id"),
                raw.get("harvest_area_m2"),
                raw.get("gross_grain_weight_kg"),
                raw.get("grain_moisture_percent"),
                comp.get("yield_tha", o["payload"].get("yield_tha")),
                comp.get("grains_per_m2"),
            ])
        style_header(ws5[1])

        # Sheet 6: Biomass Data
        ws6 = wb.create_sheet(title="Biomass_Data")
        ws6.append(["Obs ID", "Protocol ID", "Plot No", "Treatment ID", "Area (m2)", "Wet Weight (kg)", "Dry Weight (kg)", "Dry Yield (t/ha)", "H2O Biomass (t)"])
        for o in [x for x in all_obs if x["module_type"] == "biomass"]:
            raw = o["payload"].get("raw_inputs", {})
            comp = o["payload"].get("computed_results", {})
            ws6.append([
                o["obs_id"],
                o["protocol_id"],
                o["payload"].get("plot_no"),
                o["payload"].get("treatment_id"),
                raw.get("area_m2"),
                raw.get("wet_weight_kg"),
                raw.get("dry_weight_kg"),
                comp.get("dry_yield_tha", o["payload"].get("dry_yield_tha")),
                comp.get("h2o_biomass_tha"),
            ])
        style_header(ws6[1])

        # Sheet 7: Events Report (Annex I, p. 13)
        ws7 = wb.create_sheet(title="Events_Report")
        ws7.append(["Obs ID", "Protocol ID", "Event Date", "Event Type", "Severity", "Impact Description", "Logged On"])
        for o in [x for x in all_obs if x["module_type"] == "events"]:
            raw = o["payload"].get("raw_inputs", {})
            ws7.append([
                o["obs_id"],
                o["protocol_id"],
                raw.get("date"),
                raw.get("event_type"),
                raw.get("severity"),
                raw.get("description"),
                str(o["created_on"]),
            ])
        style_header(ws7[1])

        # Sheet 8+: Custom Research Evaluation Forms
        with transaction() as cur:
            cur.execute("""
                SELECT s.*, f.title AS form_title
                FROM research_form_submission s
                JOIN research_form f ON f.form_id = s.form_id
                WHERE s.trial_id = %s
                ORDER BY s.created_on
            """, (trial_id,))
            custom_subs = [dict(r) for r in cur.fetchall()]

        subs_by_form: Dict[str, List[Dict[str, Any]]] = {}
        for s in custom_subs:
            subs_by_form.setdefault(s["form_title"], []).append(s)

        for f_title, items in subs_by_form.items():
            safe_title = f"Form_{f_title[:22]}".replace("/", "_").replace("\\", "_").replace(" ", "_")
            c_ws = wb.create_sheet(title=safe_title)
            all_keys: List[str] = []
            for item in items:
                d = item.get("data") or {}
                for k in d.keys():
                    if k not in all_keys:
                        all_keys.append(k)
            c_ws.append(["Submission ID", "Cycle ID", "Plot No", "Treatment ID"] + all_keys + ["Logged On"])
            for item in items:
                d = item.get("data") or {}
                c_row = [
                    item["submission_id"],
                    item.get("cycle_id") or "-",
                    item.get("plot_no") or "-",
                    item.get("treatment_id") or "-",
                ]
                for k in all_keys:
                    c_row.append(str(d.get(k, "-")))
                c_row.append(str(item["created_on"]))
                c_ws.append(c_row)
            style_header(c_ws[1])

        # Auto-adjust column widths across all sheets
        for ws in wb.worksheets:
            for col in ws.columns:
                max_len = max(len(str(cell.value or "")) for cell in col)
                col_letter = openpyxl.utils.get_column_letter(col[0].column)
                ws.column_dimensions[col_letter].width = max(max_len + 3, 12)

        output = io.BytesIO()
        wb.save(output)
        output.seek(0)
        return output

    @staticmethod
    def export_form_workbook(form_id: str) -> io.BytesIO:
        """Export a research form definition and its plot submissions to Excel."""
        form = ResearchFormService.get_form(form_id)
        if not form:
            raise ValueError(f"Research form '{form_id}' not found")

        wb = openpyxl.Workbook()
        header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
        header_fill = PatternFill(start_color="1A5F3F", end_color="1A5F3F", fill_type="solid")
        border = Border(
            left=Side(style="thin", color="CCCCCC"),
            right=Side(style="thin", color="CCCCCC"),
            top=Side(style="thin", color="CCCCCC"),
            bottom=Side(style="thin", color="CCCCCC"),
        )

        def style_header(row):
            for cell in row:
                cell.font = header_font
                cell.fill = header_fill
                cell.alignment = Alignment(horizontal="center", vertical="center")
                cell.border = border

        # Sheet 1: Form Information & Questions
        ws1 = wb.active
        ws1.title = "Form_Definition"
        ws1.append(["Field", "Value"])
        ws1.append(["Form ID", form["form_id"]])
        ws1.append(["Title", form["title"]])
        ws1.append(["Description", form.get("description") or ""])
        ws1.append(["Category", form.get("category") or "General Agronomy"])
        ws1.append(["Status", form.get("status") or "Draft"])
        ws1.append(["Created By", form.get("created_by") or ""])
        ws1.append(["Created On", str(form.get("created_on") or "")])
        ws1.append([])
        ws1.append(["#", "Question Name", "Label", "Type", "Required", "Section", "Help Text"])
        header_idx = ws1.max_row
        style_header(ws1[1])
        style_header(ws1[header_idx])

        fj = form.get("form_json") or {}
        fields = fj.get("fields", [])
        for i, f in enumerate(fields, 1):
            ws1.append([
                i,
                f.get("name", ""),
                f.get("label", ""),
                f.get("type", "text"),
                "Yes" if f.get("required") else "No",
                f.get("section") or "Default",
                f.get("help_text") or "",
            ])

        # Sheet 2: Submissions & Plot Observations
        ws2 = wb.create_sheet(title="Submissions")
        subs = ResearchFormService.list_submissions(form_id=form_id)
        all_field_names = [f.get("name") for f in fields if f.get("name")]

        ws2.append(["Submission ID", "Trial ID", "Cycle ID", "Plot No", "Treatment ID"] + all_field_names + ["Created By", "Recorded On"])
        style_header(ws2[1])

        for sub in subs:
            data = sub.get("data") or {}
            row_vals = [
                sub["submission_id"],
                sub.get("trial_id") or "-",
                sub.get("cycle_id") or "-",
                sub.get("plot_no") or "-",
                sub.get("treatment_id") or "-",
            ]
            for fn in all_field_names:
                row_vals.append(str(data.get(fn, "-")))
            row_vals.append(sub.get("created_by") or "-")
            row_vals.append(str(sub.get("created_on") or ""))
            ws2.append(row_vals)

        # Auto-adjust column widths
        for ws in wb.worksheets:
            for col in ws.columns:
                max_len = max(len(str(cell.value or "")) for cell in col)
                col_letter = openpyxl.utils.get_column_letter(col[0].column)
                ws.column_dimensions[col_letter].width = max(max_len + 3, 12)

        output = io.BytesIO()
        wb.save(output)
        output.seek(0)
        return output


# --------------------------------------------------------------------------- #
# 7. Research Form Studio Service (Visual Web/Mobile Forms for Scientists)
# --------------------------------------------------------------------------- #
class ResearchFormService:
    @staticmethod
    def list_forms(
        platform_id: Optional[str] = None,
        trial_id: Optional[str] = None,
        category: Optional[str] = None,
        status: Optional[str] = None,
        search: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        with transaction() as cur:
            query = """
                SELECT f.form_id, f.title, f.description, f.category, f.platform_id,
                       f.trial_id, f.channel, f.status, f.created_on, f.updated_on, f.created_by,
                       COALESCE(sub.cnt, 0) AS submission_count,
                       jsonb_array_length(COALESCE(f.form_json->'fields', '[]'::jsonb)) AS field_count
                FROM research_form f
                LEFT JOIN (
                    SELECT form_id, COUNT(*) AS cnt
                    FROM research_form_submission
                    GROUP BY form_id
                ) sub ON sub.form_id = f.form_id
                WHERE 1=1
            """
            params: List[Any] = []
            if platform_id:
                query += " AND (f.platform_id = %s OR f.platform_id IS NULL)"
                params.append(platform_id)
            if trial_id:
                query += " AND (f.trial_id = %s OR f.trial_id IS NULL)"
                params.append(trial_id)
            if category:
                query += " AND f.category = %s"
                params.append(category)
            if status:
                query += " AND f.status = %s"
                params.append(status)
            if search:
                query += " AND (f.title ILIKE %s OR f.description ILIKE %s)"
                params.extend([f"%{search}%", f"%{search}%"])

            query += " ORDER BY f.created_on DESC"
            cur.execute(query, tuple(params))
            return [dict(r) for r in cur.fetchall()]

    @staticmethod
    def get_form(form_id: str) -> Optional[Dict[str, Any]]:
        with transaction() as cur:
            cur.execute("SELECT * FROM research_form WHERE form_id = %s", (form_id,))
            row = cur.fetchone()
            if not row:
                return None
            res = dict(row)
            if isinstance(res.get("form_json"), str):
                res["form_json"] = json.loads(res["form_json"])
            return res

    @staticmethod
    def create_form(
        title: str,
        description: str = "",
        category: str = "General Agronomy",
        form_json: Optional[Dict[str, Any]] = None,
        platform_id: Optional[str] = None,
        trial_id: Optional[str] = None,
        status: str = "Draft",
        created_by: str = "",
    ) -> Dict[str, Any]:
        form_id = _next_id("RFRM", "research_form", "form_id")
        base_json = form_json or {
            "title": title,
            "description": description,
            "channel": "web_mobile",
            "version": 1,
            "sections": [{"key": "sec_1", "title": "General Observations", "description": ""}],
            "fields": [
                {
                    "name": "plot_no",
                    "label": "Plot Number",
                    "type": "number",
                    "required": True,
                    "section": "sec_1",
                    "validation": {"min": 1, "max": 999},
                    "order": 1,
                }
            ],
            "layout": {"sections": [{"id": "sec_1", "containers": [{"id": "c_1", "width": 12, "fields": ["plot_no"]}]}]},
            "rules": [],
        }

        with transaction() as cur:
            cur.execute(
                """
                INSERT INTO research_form (form_id, title, description, category, platform_id, trial_id, channel, status, form_json, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    form_id,
                    title,
                    description,
                    category,
                    platform_id,
                    trial_id,
                    "web_mobile",
                    status,
                    Json(base_json),
                    created_by,
                ),
            )
            res = dict(cur.fetchone())
            if isinstance(res.get("form_json"), str):
                res["form_json"] = json.loads(res["form_json"])
            return res

    @staticmethod
    def update_form(
        form_id: str,
        form_json: Dict[str, Any],
        title: Optional[str] = None,
        description: Optional[str] = None,
        category: Optional[str] = None,
        status: Optional[str] = None,
    ) -> Dict[str, Any]:
        with transaction() as cur:
            cur.execute("SELECT * FROM research_form WHERE form_id = %s", (form_id,))
            current = cur.fetchone()
            if not current:
                raise ValueError(f"Research form '{form_id}' does not exist.")

            new_title = title if title is not None else (form_json.get("title") or current["title"])
            new_desc = description if description is not None else (form_json.get("description") or current["description"])
            new_cat = category if category is not None else current["category"]
            new_status = status if status is not None else current["status"]

            # Ensure channel is strictly web_mobile
            form_json["channel"] = "web_mobile"

            cur.execute(
                """
                UPDATE research_form
                SET title = %s, description = %s, category = %s, status = %s,
                    form_json = %s, updated_on = CURRENT_TIMESTAMP
                WHERE form_id = %s
                RETURNING *
                """,
                (new_title, new_desc, new_cat, new_status, Json(form_json), form_id),
            )
            res = dict(cur.fetchone())
            if isinstance(res.get("form_json"), str):
                res["form_json"] = json.loads(res["form_json"])
            return res

    @staticmethod
    def delete_form(form_id: str) -> bool:
        with transaction() as cur:
            cur.execute("DELETE FROM research_form WHERE form_id = %s", (form_id,))
            return cur.rowcount > 0

    @staticmethod
    def duplicate_form(form_id: str, created_by: str = "") -> Dict[str, Any]:
        with transaction() as cur:
            cur.execute("SELECT * FROM research_form WHERE form_id = %s", (form_id,))
            orig = cur.fetchone()
            if not orig:
                raise ValueError(f"Research form '{form_id}' does not exist.")

            new_id = _next_id("RFRM", "research_form", "form_id")
            new_title = f"{orig['title']} (Copy)"
            form_json = orig["form_json"] if isinstance(orig["form_json"], dict) else json.loads(orig["form_json"])
            form_json["title"] = new_title

            cur.execute(
                """
                INSERT INTO research_form (form_id, title, description, category, platform_id, trial_id, channel, status, form_json, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    new_id,
                    new_title,
                    orig["description"],
                    orig["category"],
                    orig["platform_id"],
                    orig["trial_id"],
                    "web_mobile",
                    "Draft",
                    Json(form_json),
                    created_by,
                ),
            )
            res = dict(cur.fetchone())
            if isinstance(res.get("form_json"), str):
                res["form_json"] = json.loads(res["form_json"])
            return res

    @staticmethod
    def submit(
        form_id: str,
        data: Dict[str, Any],
        trial_id: Optional[str] = None,
        cycle_id: Optional[str] = None,
        plot_no: Optional[int] = None,
        treatment_id: Optional[int] = None,
        created_by: str = "",
    ) -> Dict[str, Any]:
        sub_id = _next_id("RSUB", "research_form_submission", "submission_id")

        # Auto-lookup treatment if plot_no is given and trial/cycle has protocol
        if plot_no and cycle_id and not treatment_id:
            with transaction() as cur:
                cur.execute(
                    """
                    SELECT p.payload FROM research_protocol p
                    WHERE p.cycle_id = %s
                    """,
                    (cycle_id,),
                )
                prot_row = cur.fetchone()
                if prot_row and prot_row["payload"]:
                    pl = prot_row["payload"]
                    snap = pl.get("frozen_treatments_snapshot", {})
                    plots = snap.get("repeats_table", [])
                    match = next((p for p in plots if p.get("plot_no") == plot_no), None)
                    if match:
                        treatment_id = match.get("treatment_id")

        with transaction() as cur:
            cur.execute(
                """
                INSERT INTO research_form_submission (submission_id, form_id, trial_id, cycle_id, plot_no, treatment_id, data, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (sub_id, form_id, trial_id, cycle_id, plot_no, treatment_id, Json(data), created_by),
            )
            return dict(cur.fetchone())

    @staticmethod
    def list_submissions(
        form_id: Optional[str] = None,
        trial_id: Optional[str] = None,
        cycle_id: Optional[str] = None,
        plot_no: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        with transaction() as cur:
            query = """
                SELECT s.submission_id, s.form_id, s.trial_id, s.cycle_id,
                       s.plot_no, s.treatment_id, s.data, s.created_on, s.created_by,
                       f.title AS form_title
                FROM research_form_submission s
                JOIN research_form f ON f.form_id = s.form_id
                WHERE 1=1
            """
            params: List[Any] = []
            if form_id:
                query += " AND s.form_id = %s"
                params.append(form_id)
            if trial_id:
                query += " AND s.trial_id = %s"
                params.append(trial_id)
            if cycle_id:
                query += " AND s.cycle_id = %s"
                params.append(cycle_id)
            if plot_no:
                query += " AND s.plot_no = %s"
                params.append(plot_no)

            query += " ORDER BY s.created_on DESC"
            cur.execute(query, tuple(params))
            return [dict(r) for r in cur.fetchall()]

    @staticmethod
    def get_package(form_id: str) -> Dict[str, Any]:
        """Offline package bundle for mobile field apps."""
        form = ResearchFormService.get_form(form_id)
        if not form:
            raise ValueError(f"Research form '{form_id}' not found.")

        form_json = form.get("form_json", {})
        return {
            "package_version": 1,
            "form_id": form_id,
            "title": form.get("title"),
            "category": form.get("category"),
            "channel": "web_mobile",
            "version": form_json.get("version", 1),
            "sections": form_json.get("sections", []),
            "fields": form_json.get("fields", []),
            "layout": form_json.get("layout", {}),
            "rules": form_json.get("rules", []),
            "status": form.get("status"),
            "updated_on": str(form.get("updated_on")),
        }

    @staticmethod
    def get_public_share_state(form_id: str) -> Dict[str, Any]:
        with transaction() as cur:
            cur.execute(
                """
                SELECT public_token, public_enabled, public_expires_on,
                       public_allow_multiple, public_shared_by, public_shared_on,
                       status, title
                FROM research_form
                WHERE form_id = %s
                """,
                (form_id,),
            )
            row = cur.fetchone()
            if not row:
                raise ValueError(f"Research form '{form_id}' not found.")

            return {
                "form_id": form_id,
                "title": row.get("title"),
                "status": row.get("status"),
                "enabled": bool(row.get("public_enabled")),
                "token": row.get("public_token"),
                "expires_on": str(row.get("public_expires_on")) if row.get("public_expires_on") else None,
                "allow_multiple": bool(row.get("public_allow_multiple", True)),
                "shared_by": row.get("public_shared_by"),
                "shared_on": str(row.get("public_shared_on")) if row.get("public_shared_on") else None,
            }

    @staticmethod
    def share_publicly(
        form_id: str,
        shared_by: str,
        *,
        regenerate: bool = False,
        expires_on: Optional[str] = None,
        allow_multiple: bool = True,
    ) -> Dict[str, Any]:
        with transaction() as cur:
            cur.execute(
                "SELECT form_id, status, public_token FROM research_form WHERE form_id = %s FOR UPDATE",
                (form_id,),
            )
            row = cur.fetchone()
            if not row:
                raise ValueError(f"Research form '{form_id}' not found.")

            if row.get("status") != "Active":
                raise ValueError("Only an active research form can be shared publicly. Please publish it first.")

            existing_token = row.get("public_token")
            token = secrets.token_urlsafe(32) if (regenerate or not existing_token) else existing_token

            exp_val = None
            if expires_on:
                try:
                    exp_val = datetime.fromisoformat(expires_on.replace("Z", "+00:00"))
                except Exception:
                    exp_val = None

            cur.execute(
                """
                UPDATE research_form
                SET public_token = %s,
                    public_enabled = TRUE,
                    public_expires_on = %s,
                    public_allow_multiple = %s,
                    public_shared_by = %s,
                    public_shared_on = CURRENT_TIMESTAMP
                WHERE form_id = %s
                """,
                (token, exp_val, allow_multiple, shared_by, form_id),
            )

        return ResearchFormService.get_public_share_state(form_id)

    @staticmethod
    def disable_public_share(form_id: str) -> Dict[str, Any]:
        with transaction() as cur:
            cur.execute(
                "UPDATE research_form SET public_enabled = FALSE WHERE form_id = %s",
                (form_id,),
            )
        return ResearchFormService.get_public_share_state(form_id)

    @staticmethod
    def resolve_public_token(token: str, trial_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        if not token:
            return None

        with transaction() as cur:
            cur.execute(
                """
                SELECT form_id, title, description, category, platform_id, trial_id,
                       channel, status, form_json, public_expires_on, public_allow_multiple
                FROM research_form
                WHERE public_token = %s
                  AND public_enabled = TRUE
                  AND status = 'Active'
                """,
                (token,),
            )
            row = cur.fetchone()
            if not row:
                return None

            if row.get("public_expires_on") and row["public_expires_on"] < datetime.now():
                return None

            form_dict = dict(row)
            if isinstance(form_dict.get("form_json"), str):
                form_dict["form_json"] = json.loads(form_dict["form_json"])

            bound_trial_id = form_dict.get("trial_id")
            effective_trial = bound_trial_id or trial_id
            trials_info = []
            if bound_trial_id:
                cur.execute("SELECT trial_id, name, payload FROM research_trial WHERE trial_id = %s", (bound_trial_id,))
                t_row = cur.fetchone()
                if t_row:
                    trials_info.append({"trial_id": t_row["trial_id"], "name": t_row["name"]})
            else:
                cur.execute("SELECT trial_id, name FROM research_trial ORDER BY name LIMIT 50")
                trials_info = [{"trial_id": r["trial_id"], "name": r["name"]} for r in cur.fetchall()]

            form_dict["trials"] = trials_info

            if effective_trial:
                cur.execute(
                    """
                    SELECT c.cycle_id, c.year, c.season, p.protocol_id, p.payload AS protocol_payload
                    FROM research_cycle c
                    LEFT JOIN research_protocol p ON p.cycle_id = c.cycle_id
                    WHERE c.trial_id = %s
                    ORDER BY c.year DESC, c.season DESC
                    """,
                    (effective_trial,),
                )
                form_dict["cycles"] = [dict(c) for c in cur.fetchall()]
            else:
                form_dict["cycles"] = []

            return form_dict

    @staticmethod
    def get_public_cycles(token: str, trial_id: Optional[str] = None) -> List[Dict[str, Any]]:
        form = ResearchFormService.resolve_public_token(token)
        if not form:
            raise ValueError("This public research form link is not valid or has expired.")

        target_trial = form.get("trial_id") or trial_id
        if not target_trial:
            return []

        with transaction() as cur:
            cur.execute(
                """
                SELECT c.cycle_id, c.year, c.season, p.protocol_id, p.payload AS protocol_payload
                FROM research_cycle c
                LEFT JOIN research_protocol p ON p.cycle_id = c.cycle_id
                WHERE c.trial_id = %s
                ORDER BY c.year DESC, c.season DESC
                """,
                (target_trial,),
            )
            return [dict(c) for c in cur.fetchall()]

    @staticmethod
    def submit_public(
        token: str,
        data: Dict[str, Any],
        trial_id: Optional[str] = None,
        cycle_id: Optional[str] = None,
        plot_no: Optional[int] = None,
        treatment_id: Optional[int] = None,
        evaluator_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        form = ResearchFormService.resolve_public_token(token)
        if not form:
            raise ValueError("This public research form link is not valid or has expired.")

        form_id = form["form_id"]
        final_trial_id = form.get("trial_id") or trial_id
        author = f"Public evaluator: {evaluator_name.strip()}" if evaluator_name and evaluator_name.strip() else "Public Link (Research)"

        return ResearchFormService.submit(
            form_id=form_id,
            data=data,
            trial_id=final_trial_id,
            cycle_id=cycle_id,
            plot_no=plot_no,
            treatment_id=treatment_id,
            created_by=author,
        )
