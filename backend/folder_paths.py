from typing import List


def normalize_folder_path(path: str) -> str:
    trimmed = path.strip().strip('"').strip("'")
    if trimmed in ("/", "\\"):
        return trimmed
    if len(trimmed) == 3 and trimmed[1] == ":" and trimmed[2] in ("/", "\\"):
        return trimmed
    return trimmed.rstrip("/\\")


def folder_path_variants(path: str) -> List[str]:
    normalized = normalize_folder_path(path)
    variants = []

    for variant in (normalized, normalized.replace("\\", "/"), normalized.replace("/", "\\")):
        if variant and variant not in variants:
            variants.append(variant)

    return variants


def escape_sql_like(value: str) -> str:
    return (
        value
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )


def folder_branch_like_patterns(path: str) -> List[str]:
    patterns = []

    for variant in folder_path_variants(path):
        for separator in ("/", "\\"):
            escaped_separator = "\\\\" if separator == "\\" else separator
            pattern = f"{escape_sql_like(variant)}{escaped_separator}%"
            if pattern not in patterns:
                patterns.append(pattern)

    return patterns
