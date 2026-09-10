#!/usr/bin/env python3
import sys

from ds_store import DSStore
from mac_alias import Alias


def main():
    ds_store_path, background_path = sys.argv[1:3]
    with DSStore.open(ds_store_path, "r+") as store:
        icon_view = store["."]["icvp"]
        icon_view["backgroundImageAlias"] = Alias.for_file(background_path).to_bytes()
        store["."]["icvp"] = icon_view


if __name__ == "__main__":
    main()
