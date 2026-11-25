#!/usr/bin/env python3
"""Turn downloaded City of LA (LADBS) permits into Property Improvement lexicon outputs.

One zip per published LA parcel that has permits, in the same layout the county archive
was hashed from (data/<files>.json):
  - Seed group, copied byte-for-byte from that parcel's county transformed.zip
    (seed root, address_has_parcel, address, parcel), so the property CID is the same
  - property.json, copied from the county output (the from-side of every permit link)
  - Property Improvement group root -> property_has_property_improvement[] -> permits

usage: ladbs-permit-lexicon.py <permit job dir> <county run dir> <out dir> [--only AIN,AIN] [--limit N]
Writes <out dir>/<ain>.zip and <out dir>/../<name>-report.json (mapping counts).
Mapping rules live in the tables below; anything not listed maps to null, never a guess.
"""
import argparse, collections, datetime, glob, gzip, json, os, re, sys, zipfile

SEED = "bafkreibhurphpjdq33ysit57jtzmdldgngepsdbsw4vm7esawth2ezgaxu"
PI_GROUP = "bafkreicyzywzwhmguojpi2otgrwsyi37le3u4lnavljbxu76cnrudxaxfu"
SEED_FILES = ("address_has_parcel.json", "address.json", "parcel.json")

# LADBS permit_type -> lexicon improvement_type (before the roof / solar / use refinements)
TYPE = {
    "Bldg-Addition": "BuildingAddition",
    "Bldg-Demolition": "Demolition",
    "Nonbldg-Demolition": "Demolition",
    "Bldg-Relocation": "StructureMove",
    "Grading": "SiteDevelopment",
    "Swimming-Pool/Spa": "PoolSpaInstallation",
    "Sign": "GeneralBuilding",
    "Nonbldg-New": "GeneralBuilding",
    "Nonbldg-Alter/Repair": "GeneralBuilding",
    "Nonbldg-Addition": "GeneralBuilding",
    # Bldg-New and Bldg-Alter/Repair are split by building use below
}
# LADBS permit_sub_type (building use) for Bldg-New / Bldg-Alter/Repair
RESIDENTIAL_USE = {"1 or 2 Family Dwelling", "Apartment"}
COMMERCIAL_USE = {"Commercial"}
ACTION = {
    "Bldg-New": "New", "Nonbldg-New": "New",
    "Bldg-Addition": "Addition", "Nonbldg-Addition": "Addition",
    "Bldg-Demolition": "Remove", "Nonbldg-Demolition": "Remove",
    "Bldg-Relocation": "Other",
    # Alter/Repair, pool, grading and sign permits do not say which action: null
}
# Explicit roofing text in the work description (re-roof / roof covering / roofing)
ROOF_TEXT = re.compile(r"\bre-?\s?roof|\broof(?:ing)?\s+(?:covering|replacement|repair)|\broofing\b", re.I)
# LADBS status_desc -> lexicon improvement_status
STATUS = {
    "Permit Finaled": "Completed", "CofO Issued": "Completed", "CofC Issued": "Completed",
    "CofO Corrected": "Completed", "CofC Corrected": "Completed", "CofO Superseded": "Completed",
    "CofO Reactivated": "Completed", "Grading Cert. Issued": "Completed",
    "Issued": "Permitted", "Re-Activate Permit": "Permitted", "Permit Extended": "Permitted",
    "Insp Scheduled": "InProgress", "Partial Inspection": "InProgress", "Partial Approval": "InProgress",
    "CofO in Progress": "InProgress", "OK for CofC": "InProgress", "OK to Issue CofC": "InProgress",
    "Not Ready for Inspection": "InProgress", "TCO Issued": "InProgress", "TCO Renewed": "InProgress",
    "Intent to Correct CofC": "InProgress", "No Progress": "OnHold", "Intent to Revoke": "OnHold",
    "Intent to Revoke CofC": "OnHold", "Order to Comply Issued": "OnHold",
    "Permit Expired": "Cancelled", "Refund in Progress": "Cancelled", "Not Issued": "Cancelled",
    "Application Submittal": "Planned", "PC Approved": "Planned", "PC Extended": "Planned",
    "Ready to Issue": "Planned", "Not Ready to Issue": "Planned",
    # "Permit Closed", "Refund Denied", "Not Required": no defensible lexicon status -> null
}
MIN_DATE, MAX_DATE = "1900-01-01", datetime.date.today().isoformat()


def check_date(value, counts, name):
    if value is None:
        return None
    if not (MIN_DATE <= value <= MAX_DATE):
        counts[f"date_quarantined:{name}"] += 1
        return None
    return value


def improvement_type(rec, payload, counts):
    permit_type = rec["improvement_type"]
    text = rec.get("description") or ""
    # LADBS "solar" flag is "N" on every row checked, so it is not used.
    if permit_type in ("Bldg-Alter/Repair", "Nonbldg-Alter/Repair") and ROOF_TEXT.search(text):
        return "Roofing"
    if permit_type in ("Bldg-New", "Bldg-Alter/Repair"):
        use = payload.get("permitSubType")
        if use in RESIDENTIAL_USE:
            return "ResidentialConstruction"
        if use in COMMERCIAL_USE:
            return "CommercialConstruction"
        return "GeneralBuilding"
    mapped = TYPE.get(permit_type)
    if mapped is None:
        counts[f"type_unmapped:{permit_type}"] += 1
    return mapped


def permit_block(rec, counts):
    payload = rec["sourcePayload"]
    dataset = payload["dataset"]["id"]
    status = STATUS.get(rec["improvement_status"])
    if status is None:
        counts[f"status_null:{rec['improvement_status']}"] += 1
    final = check_date(rec["final_inspection_date"], counts, "final")
    block = {
        "source_http_request": {
            "method": "GET",
            "url": f"https://data.lacity.org/resource/{dataset}.json",
            "multiValueQueryString": {"permit_nbr": [rec["permit_number"]]},
        },
        "request_identifier": rec["permit_number"],
        "permit_number": rec["permit_number"],
        "permit_required": True,
        "improvement_type": improvement_type(rec, payload, counts),
        "improvement_action": ACTION.get(rec["improvement_type"]),
        "improvement_status": status,
        "contractor_type": None,
        "application_received_date": check_date(rec["application_received_date"], counts, "applied"),
        "permit_issue_date": check_date(rec["permit_issue_date"], counts, "issued"),
        # LADBS status_date is the date the record reached its current status; it is the
        # final-inspection date only when that status is "Permit Finaled".
        "final_inspection_date": final,
        "completion_date": None,
    }
    counts[f"type:{block['improvement_type']}"] += 1
    counts[f"status:{status}"] += 1
    return block


def build_zip(ain, recs, county_zip, out_path, counts):
    with zipfile.ZipFile(county_zip) as src:
        seed = {name: src.read(f"data/{name}") for name in (f"{SEED}.json",) + SEED_FILES}
        prop = src.read("data/property.json")
    rels, files = [], {}
    for i, rec in enumerate(sorted(recs, key=lambda r: r["permit_number"]), 1):
        files[f"property_improvement_{i}.json"] = permit_block(rec, counts)
        files[f"relationship_property_has_property_improvement_{i}.json"] = {
            "from": {"/": "./property.json"}, "to": {"/": f"./property_improvement_{i}.json"}}
        rels.append({"/": f"./relationship_property_has_property_improvement_{i}.json"})
    files[f"{PI_GROUP}.json"] = {"label": "Property Improvement",
                                 "relationships": {"property_has_property_improvement": rels}}
    tmp = out_path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in seed.items():
            z.writestr(f"data/{name}", data)
        z.writestr("data/property.json", prop)
        for name, obj in files.items():
            z.writestr(f"data/{name}", json.dumps(obj, indent=2))
    os.replace(tmp, out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("permit_job"); ap.add_argument("county_run"); ap.add_argument("out")
    ap.add_argument("--only", default=""); ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    only = set(filter(None, a.only.split(",")))
    os.makedirs(a.out, exist_ok=True)
    by_parcel = collections.defaultdict(list)
    for page in sorted(glob.glob(os.path.join(a.permit_job, "pages", "*.jsonl.gz"))):
        with gzip.open(page, "rt") as f:
            for line in f:
                rec = json.loads(line)
                ain = rec["parcel_identifier"]
                if ain == "unlinked" or (only and ain not in only):
                    continue
                by_parcel[ain].append(rec)
    counts = collections.Counter()
    done = 0
    for ain in sorted(by_parcel):
        county_zip = os.path.join(a.county_run, "parcels", ain[:4], ain, "transformed.zip")
        if not os.path.exists(county_zip):
            counts["parcel_not_published"] += 1
            counts["permits_on_unpublished_parcels"] += len(by_parcel[ain])
            continue
        out_path = os.path.join(a.out, f"{ain}.zip")
        build_zip(ain, by_parcel[ain], county_zip, out_path, counts)
        counts["parcels_written"] += 1
        counts["permits_written"] += len(by_parcel[ain])
        done += 1
        if done % 50000 == 0:
            print(f"{datetime.datetime.now():%H:%M:%S} {done} parcels", flush=True)
        if a.limit and done >= a.limit:
            break
    report = dict(sorted(counts.items()))
    with open(os.path.join(os.path.dirname(os.path.abspath(a.out)), os.path.basename(a.out.rstrip("/")) + "-report.json"), "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
