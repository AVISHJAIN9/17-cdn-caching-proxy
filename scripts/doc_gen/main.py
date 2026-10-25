import os
import sys

# Ensure current module directory is on sys.path
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from gen_overview import generate_overview
from gen_features import generate_features
from gen_core_guides import generate_core_guides
from gen_interview_qa import generate_interview_qa
from gen_checklist import generate_checklist
from gen_system_design import generate_system_design
from gen_misc import generate_misc

def main():
    root_dir = "/Users/avishjain/avishjain9-repos/17-cdn-caching-proxy"
    docs_dir = os.path.join(root_dir, "docs")

    print("=== Starting Full Documentation Generation for 17-CDN-Caching-Proxy ===")
    
    print("\n[1/7] Generating Project Overview & Classification...")
    generate_overview(docs_dir)

    print("\n[2/7] Generating Feature Inventory (F1 - F16) & Specs...")
    generate_features(docs_dir)

    print("\n[3/7] Generating Core Guides, Architecture & Comparisons...")
    generate_core_guides(docs_dir)

    print("\n[4/7] Generating 150+ Technical Interview Questions & Answers...")
    generate_interview_qa(docs_dir)

    print("\n[5/7] Generating Master Checklist (All 275 Items + Coverage Table)...")
    generate_checklist(docs_dir)

    print("\n[6/7] Generating System Design Deep Dive (17 Topics + ADRs)...")
    generate_system_design(docs_dir)

    print("\n[7/7] Generating Gaps, Glossary, Rehearsal Scripts & VitePress Theme...")
    generate_misc(docs_dir, root_dir)

    print("\n=== All Documentation Files Generated Successfully! ===")

if __name__ == "__main__":
    main()
