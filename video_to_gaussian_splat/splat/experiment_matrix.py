"""Enumerate candidate 3DGS experiment pipeline combinations."""

from __future__ import annotations

import csv
import io
import json
from dataclasses import asdict, dataclass
from itertools import product
from typing import Iterable, Literal


Status = Literal["implemented", "partial", "planned", "external"]


@dataclass(frozen=True)
class Option:
    id: str
    label: str
    status: Status
    provides: frozenset[str]
    requires: frozenset[str] = frozenset()
    notes: str = ""


@dataclass(frozen=True)
class PipelineCombination:
    id: str
    input_stage: str
    geometry_stage: str
    refinement_stage: str
    cleanup_stage: str
    status: Status
    runnable_now: bool
    why: str


@dataclass(frozen=True)
class RankedPipelineCombination(PipelineCombination):
    rank: int
    score: int
    priority: str
    rationale: str


INPUT_STAGES: tuple[Option, ...] = (
    Option(
        id="classic_topk",
        label="Classic per-camera top-K frame QC",
        status="implemented",
        provides=frozenset({"videos", "images"}),
        notes="Current frame extractor/QC path.",
    ),
    Option(
        id="sync_keyframes",
        label="Synchronized multi-view keyframes",
        status="partial",
        provides=frozenset({"videos", "images", "pairs", "timestamps"}),
        notes="Creates images/, pairs.txt, and manifest.json; not wired into full upload/training path yet.",
    ),
    Option(
        id="fixed_rig_sync",
        label="Fixed-rig synchronized keyframes",
        status="planned",
        provides=frozenset({"videos", "images", "pairs", "timestamps", "rig_calibration"}),
        notes="Requires a one-time rig calibration capture.",
    ),
    Option(
        id="posed_rgbd_dataset",
        label="Posed RGB-D / dataset adapter",
        status="planned",
        provides=frozenset({"images", "known_poses", "depth"}),
        notes="For ScanNet, ARKitScenes, TUM RGB-D, 7-Scenes, etc.",
    ),
)


GEOMETRY_STAGES: tuple[Option, ...] = (
    Option(
        id="colmap_auto",
        label="COLMAP exhaustive/sequential",
        status="implemented",
        requires=frozenset({"images"}),
        provides=frozenset({"poses", "scene_points"}),
        notes="Existing SfM path; ignores pair lists.",
    ),
    Option(
        id="colmap_pairs",
        label="COLMAP pair-list matching",
        status="partial",
        requires=frozenset({"images", "pairs"}),
        provides=frozenset({"poses", "scene_points"}),
        notes="Remote run_sfm.sh supports pairs.txt; normal upload path still needs pairs packaging.",
    ),
    Option(
        id="fixed_rig_trajectory",
        label="Fixed-rig trajectory solve",
        status="planned",
        requires=frozenset({"images", "rig_calibration", "timestamps"}),
        provides=frozenset({"poses", "scene_points"}),
        notes="Solve rig trajectory instead of independent camera poses.",
    ),
    Option(
        id="vggt_geometry",
        label="VGGT-style pose/depth/point maps",
        status="external",
        requires=frozenset({"images"}),
        provides=frozenset({"poses", "scene_points", "depth"}),
        notes="Foundation geometry initializer; dependency/model integration needed.",
    ),
    Option(
        id="instantsplat_init",
        label="InstantSplat-style Gaussian init",
        status="external",
        requires=frozenset({"images"}),
        provides=frozenset({"poses", "gaussians"}),
        notes="SfM-free sparse-view Gaussian initializer.",
    ),
    Option(
        id="feedforward_gs",
        label="MVSplat / AnySplat / FreeSplatter init",
        status="external",
        requires=frozenset({"images"}),
        provides=frozenset({"poses", "gaussians"}),
        notes="Feed-forward Gaussian prediction from sparse views.",
    ),
    Option(
        id="posed_depth_init",
        label="Known-pose RGB-D initialization",
        status="planned",
        requires=frozenset({"images", "known_poses", "depth"}),
        provides=frozenset({"poses", "scene_points", "depth"}),
        notes="Use dataset/device poses and depth as the initializer.",
    ),
)


REFINEMENT_STAGES: tuple[Option, ...] = (
    Option(
        id="none",
        label="No 3DGS refinement",
        status="implemented",
        requires=frozenset({"gaussians"}),
        provides=frozenset({"splat"}),
        notes="Only valid when geometry stage directly emits Gaussians.",
    ),
    Option(
        id="gsplat_1k",
        label="gsplat quick refinement, 1000 steps",
        status="implemented",
        requires=frozenset({"poses"}),
        provides=frozenset({"splat"}),
        notes="Fastest current refinement profile.",
    ),
    Option(
        id="gsplat_2k",
        label="gsplat preview refinement, 2000 steps",
        status="implemented",
        requires=frozenset({"poses"}),
        provides=frozenset({"splat"}),
        notes="Default preview budget candidate.",
    ),
    Option(
        id="gsplat_7k",
        label="gsplat current quality path, 7000 steps",
        status="implemented",
        requires=frozenset({"poses"}),
        provides=frozenset({"splat"}),
        notes="Current normal training budget.",
    ),
    Option(
        id="fastgs_100s",
        label="FastGS-style accelerated training",
        status="external",
        requires=frozenset({"poses"}),
        provides=frozenset({"splat"}),
        notes="External acceleration framework; integration needed.",
    ),
)


CLEANUP_STAGES: tuple[Option, ...] = (
    Option(
        id="none",
        label="No diffusion cleanup",
        status="implemented",
        requires=frozenset({"splat"}),
        provides=frozenset({"final_splat"}),
    ),
    Option(
        id="difix_inference",
        label="Difix3D+ inference-time enhancer",
        status="external",
        requires=frozenset({"splat"}),
        provides=frozenset({"final_splat"}),
        notes="Enhance rendered views without changing stored splat.",
    ),
    Option(
        id="difix_distill",
        label="Difix3D+ cleanup + distillation",
        status="external",
        requires=frozenset({"splat"}),
        provides=frozenset({"final_splat"}),
        notes="Render, clean pseudo-views, distill back into the splat.",
    ),
)


STATUS_ORDER: tuple[Status, ...] = ("implemented", "partial", "external", "planned")


def enumerate_combinations(*, include_invalid: bool = False) -> list[PipelineCombination]:
    rows: list[PipelineCombination] = []
    for input_stage, geometry, refinement, cleanup in product(
        INPUT_STAGES, GEOMETRY_STAGES, REFINEMENT_STAGES, CLEANUP_STAGES,
    ):
        available = set(input_stage.provides)
        valid, reason = _satisfies(geometry, available)
        if valid:
            available.update(geometry.provides)
            valid, reason = _valid_refinement(refinement, available)
        if valid:
            available.update(refinement.provides)
            valid, reason = _satisfies(cleanup, available)
        if valid:
            available.update(cleanup.provides)
            reason = "valid"
        elif not include_invalid:
            continue

        stages = (input_stage, geometry, refinement, cleanup)
        status = _combined_status(stages)
        rows.append(PipelineCombination(
            id="-".join(stage.id for stage in stages),
            input_stage=input_stage.id,
            geometry_stage=geometry.id,
            refinement_stage=refinement.id,
            cleanup_stage=cleanup.id,
            status=status,
            runnable_now=(valid and status == "implemented"),
            why=reason,
        ))
    return rows


def render_matrix(
    rows: Iterable[PipelineCombination | RankedPipelineCombination],
    *,
    fmt: Literal["markdown", "json", "csv"] = "markdown",
) -> str:
    rows = list(rows)
    if fmt == "json":
        return json.dumps([asdict(row) for row in rows], indent=2)
    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(asdict(rows[0]).keys()) if rows else [])
        if rows:
            writer.writeheader()
            for row in rows:
                writer.writerow(asdict(row))
        return buf.getvalue()
    return _render_markdown(rows)


def rank_combinations(rows: Iterable[PipelineCombination]) -> list[RankedPipelineCombination]:
    """Rank valid combinations by near-term experimental value.

    This is intentionally a heuristic, not a theoretical claim. It favors:
      - things we can run or integrate soon,
      - using multi-view structure,
      - quick preview latency,
      - faithful geometry before diffusion cleanup.
    """
    ranked: list[tuple[int, PipelineCombination, str]] = []
    for row in rows:
        score, rationale = _score(row)
        ranked.append((score, row, rationale))

    ranked.sort(key=lambda item: (-item[0], _status_rank(item[1].status), item[1].id))
    return [
        RankedPipelineCombination(
            **asdict(row),
            rank=idx,
            score=score,
            priority=_priority(score, row.status),
            rationale=rationale,
        )
        for idx, (score, row, rationale) in enumerate(ranked, start=1)
    ]


def option_catalog() -> dict[str, list[dict]]:
    return {
        "input_stages": [_option_dict(opt) for opt in INPUT_STAGES],
        "geometry_stages": [_option_dict(opt) for opt in GEOMETRY_STAGES],
        "refinement_stages": [_option_dict(opt) for opt in REFINEMENT_STAGES],
        "cleanup_stages": [_option_dict(opt) for opt in CLEANUP_STAGES],
    }


def _valid_refinement(refinement: Option, available: set[str]) -> tuple[bool, str]:
    valid, reason = _satisfies(refinement, available)
    if not valid:
        return valid, reason
    if refinement.id != "none" and not ({"scene_points", "gaussians"} & available):
        return False, f"{refinement.id} needs scene_points or gaussians"
    return True, "valid"


def _satisfies(option: Option, available: set[str]) -> tuple[bool, str]:
    missing = sorted(option.requires - available)
    if missing:
        return False, f"{option.id} missing {','.join(missing)}"
    return True, "valid"


def _combined_status(stages: Iterable[Option]) -> Status:
    statuses = [stage.status for stage in stages]
    return max(statuses, key=STATUS_ORDER.index)


def _option_dict(option: Option) -> dict:
    d = asdict(option)
    d["requires"] = sorted(option.requires)
    d["provides"] = sorted(option.provides)
    return d


def _render_markdown(rows: list[PipelineCombination]) -> str:
    if rows and isinstance(rows[0], RankedPipelineCombination):
        return _render_ranked_markdown(rows)  # type: ignore[arg-type]
    lines = [
        "| id | input | geometry | refinement | cleanup | status | runnable_now | why |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            "| "
            + " | ".join([
                row.id,
                row.input_stage,
                row.geometry_stage,
                row.refinement_stage,
                row.cleanup_stage,
                row.status,
                "yes" if row.runnable_now else "no",
                row.why,
            ])
            + " |"
        )
    return "\n".join(lines)


def _render_ranked_markdown(rows: list[RankedPipelineCombination]) -> str:
    lines = [
        "| rank | score | priority | id | status | runnable_now | rationale |",
        "|---:|---:|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            "| "
            + " | ".join([
                str(row.rank),
                str(row.score),
                row.priority,
                row.id,
                row.status,
                "yes" if row.runnable_now else "no",
                row.rationale,
            ])
            + " |"
        )
    return "\n".join(lines)


def _score(row: PipelineCombination) -> tuple[int, str]:
    score = 0
    reasons: list[str] = []

    status_points = {
        "implemented": 30,
        "partial": 23,
        "external": 12,
        "planned": 8,
    }[row.status]
    score += status_points
    reasons.append(f"{row.status} readiness")

    input_points = {
        "classic_topk": 6,
        "sync_keyframes": 18,
        "fixed_rig_sync": 20,
        "posed_rgbd_dataset": 14,
    }[row.input_stage]
    score += input_points
    if row.input_stage in {"sync_keyframes", "fixed_rig_sync"}:
        reasons.append("uses synchronized multi-view structure")
    elif row.input_stage == "posed_rgbd_dataset":
        reasons.append("uses posed/depth data")
    else:
        reasons.append("baseline input path")

    geometry_points = {
        "colmap_auto": 12,
        "colmap_pairs": 22,
        "fixed_rig_trajectory": 24,
        "vggt_geometry": 19,
        "instantsplat_init": 18,
        "feedforward_gs": 18,
        "posed_depth_init": 21,
    }[row.geometry_stage]
    score += geometry_points
    if row.geometry_stage == "colmap_pairs":
        reasons.append("reduces matching work")
    elif row.geometry_stage == "fixed_rig_trajectory":
        reasons.append("best fit for fixed cameras")
    elif row.geometry_stage in {"vggt_geometry", "instantsplat_init", "feedforward_gs"}:
        reasons.append("tests feed-forward geometry")
    elif row.geometry_stage == "posed_depth_init":
        reasons.append("uses known pose/depth initializer")

    refinement_points = {
        "none": 9,
        "gsplat_1k": 14,
        "gsplat_2k": 17,
        "gsplat_7k": 10,
        "fastgs_100s": 18,
    }[row.refinement_stage]
    score += refinement_points
    if row.refinement_stage == "gsplat_2k":
        reasons.append("preview-quality refinement budget")
    elif row.refinement_stage == "gsplat_1k":
        reasons.append("fastest current refinement")
    elif row.refinement_stage == "fastgs_100s":
        reasons.append("promising training accelerator")
    elif row.refinement_stage == "gsplat_7k":
        reasons.append("slower quality baseline")
    else:
        reasons.append("skips refinement")

    cleanup_points = {
        "none": 10,
        "difix_inference": 7,
        "difix_distill": 8,
    }[row.cleanup_stage]
    score += cleanup_points
    if row.cleanup_stage == "none":
        reasons.append("keeps evaluation faithful")
    elif row.cleanup_stage == "difix_distill":
        reasons.append("tests diffusion distillation")
    else:
        reasons.append("tests diffusion view cleanup")

    combo_bonus = _combo_bonus(row, reasons)
    score += combo_bonus
    score -= _latency_penalty(row, reasons)
    return score, "; ".join(reasons)


def _combo_bonus(row: PipelineCombination, reasons: list[str]) -> int:
    bonus = 0
    if row.input_stage == "sync_keyframes" and row.geometry_stage == "colmap_pairs":
        bonus += 10
        reasons.append("natural first multi-view experiment")
    if row.input_stage == "fixed_rig_sync" and row.geometry_stage == "fixed_rig_trajectory":
        bonus += 10
        reasons.append("highest fixed-rig upside")
    if row.input_stage == "posed_rgbd_dataset" and row.geometry_stage == "posed_depth_init":
        bonus += 8
        reasons.append("dataset pose/depth path is direct")
    if row.input_stage in {"sync_keyframes", "fixed_rig_sync"} and row.geometry_stage in {
        "vggt_geometry",
        "instantsplat_init",
        "feedforward_gs",
    }:
        bonus += 5
        reasons.append("feed-forward model gets structured multi-view input")
    if row.geometry_stage in {"instantsplat_init", "feedforward_gs"} and row.refinement_stage == "none":
        bonus += 4
        reasons.append("tests direct Gaussian output")
    if row.refinement_stage in {"gsplat_1k", "gsplat_2k"} and row.cleanup_stage == "difix_distill":
        bonus += 3
        reasons.append("cleanup is most useful after quick coarse splats")
    return bonus


def _latency_penalty(row: PipelineCombination, reasons: list[str]) -> int:
    penalty = 0
    if row.refinement_stage == "gsplat_7k" and row.cleanup_stage != "none":
        penalty += 5
        reasons.append("slow training plus cleanup")
    if row.cleanup_stage == "difix_distill":
        penalty += 2
        reasons.append("distillation adds another training loop")
    if row.input_stage == "classic_topk" and row.geometry_stage == "colmap_auto":
        penalty += 2
        reasons.append("least multi-view-specific")
    if row.refinement_stage == "none" and row.cleanup_stage != "none":
        penalty += 3
        reasons.append("cleanup without refinement is harder to interpret")
    return penalty


def _status_rank(status: Status) -> int:
    return STATUS_ORDER.index(status)


def _priority(score: int, status: Status) -> str:
    if status in {"implemented", "partial"} and score >= 85:
        return "next"
    if score >= 78:
        return "high"
    if score >= 68:
        return "medium"
    return "low"
