import os
import sys

# Directory paths
ROOT_DIR = "/Users/avishjain/avishjain9-repos/17-cdn-caching-proxy"
DOCS_DIR = os.path.join(ROOT_DIR, "docs")
FEATURES_DIR = os.path.join(DOCS_DIR, "features")
SD_DIR = os.path.join(DOCS_DIR, "system-design")
VP_DIR = os.path.join(DOCS_DIR, ".vitepress")
THEME_DIR = os.path.join(VP_DIR, "theme")

os.makedirs(FEATURES_DIR, exist_ok=True)
os.makedirs(SD_DIR, exist_ok=True)
os.makedirs(THEME_DIR, exist_ok=True)

print("Directories prepared.")
