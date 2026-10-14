#!/usr/bin/env python3
import json
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2

base = sys.argv[1]
width = int(sys.argv[2])
path = sys.argv[3] if len(sys.argv) > 3 else "/"
done = {"ok": False, "armed": False}


def finish(view, result):
    try:
        js = view.run_javascript_finish(result)
        print(js.get_js_value().to_string())
        done["ok"] = True
    except Exception as err:
        print(json.dumps({"error": str(err)}))
    Gtk.main_quit()


def failed(*_args):
    print(json.dumps({"error": "load failed"}))
    Gtk.main_quit()


def probe(view):
    view.run_javascript(
        """JSON.stringify({
          scroll: document.documentElement.scrollWidth,
          view: window.innerWidth,
          title: document.title,
          about: Boolean(document.getElementById("about-view")),
          tabconf: document.body.innerText.includes("TabConf 8"),
          posts: document.querySelectorAll(".post, .empty-box, .skel-post").length
        })""",
        None,
        finish,
    )
    return False


def loaded(view, event):
    # SSE keeps the document from reaching FINISHED in WebKit.
    if event != WebKit2.LoadEvent.COMMITTED or done["armed"]:
        return
    done["armed"] = True
    GLib.timeout_add(1800, probe, view)


win = Gtk.Window()
win.set_default_size(width, 900)
view = WebKit2.WebView()
win.add(view)
view.connect("load-changed", loaded)
view.connect("load-failed", failed)
GLib.timeout_add(12000, Gtk.main_quit)
view.load_uri(base.rstrip("/") + path)
win.show_all()
Gtk.main()
if not done["ok"]:
    sys.exit(1)
