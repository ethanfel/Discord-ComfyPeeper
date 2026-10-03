"""Native Windows/Linux front end. End users run the packaged executable."""

from __future__ import annotations

import argparse
from pathlib import Path
import queue
import sys
import tempfile
import threading
import tkinter as tk
from tkinter import filedialog, font, messagebox, ttk
import webbrowser

from installer import VERSION, core


class InstallerWindow:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.busy = False
        self.events = queue.Queue()
        self.profile = tk.StringVar()
        self.status = tk.StringVar(value="Looking for Vesktop…")
        self.buttons = []
        root.title("ComfyPeeper Installer")
        root.geometry("730x610")
        root.minsize(670, 580)
        root.protocol("WM_DELETE_WINDOW", self.close)
        style = ttk.Style(root)
        family = "Segoe UI" if sys.platform == "win32" else font.nametofont("TkDefaultFont").actual("family")
        if "clam" in style.theme_names():
            style.theme_use("clam")
        root.configure(background="#f5f5fa")
        style.configure("TFrame", background="#f5f5fa")
        style.configure("TLabel", background="#f5f5fa", foreground="#232336", font=(family, 10))
        style.configure("Title.TLabel", font=(family, 25, "bold"))
        style.configure("Muted.TLabel", foreground="#5e6075")
        style.configure("TButton", padding=(12, 9), font=(family, 10))
        style.configure("Primary.TButton", background="#5865f2", foreground="white")
        style.map("Primary.TButton", background=[("active", "#4652d8"), ("disabled", "#a5aadd")])

        frame = ttk.Frame(root, padding=26)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="ComfyPeeper", style="Title.TLabel").pack(anchor="w")
        ttk.Label(frame, text="ComfyUI workflows, right inside Discord.", style="Muted.TLabel").pack(anchor="w", pady=(3, 18))
        ttk.Label(frame, text="Install Peeper into Vesktop in a few clicks. No developer tools required.", wraplength=660).pack(anchor="w")
        ttk.Label(frame, text="First, quit Vesktop from its tray icon. You can reopen it when installation finishes.", wraplength=660, style="Muted.TLabel").pack(anchor="w", pady=(6, 18))

        ttk.Label(frame, text="Vesktop installation").pack(anchor="w")
        row = ttk.Frame(frame)
        row.pack(fill="x", pady=(6, 5))
        self.chooser = ttk.Combobox(row, textvariable=self.profile, state="readonly")
        self.chooser.pack(side="left", fill="x", expand=True)
        self.chooser.bind("<<ComboboxSelected>>", lambda _: self.refresh_status())
        self.button(row, "Browse…", self.browse).pack(side="left", padx=(8, 0))
        linkrow = ttk.Frame(frame)
        linkrow.pack(fill="x")
        self.button(linkrow, "Get Vesktop", lambda: webbrowser.open("https://vesktop.dev/")).pack(side="left")
        self.button(linkrow, "Refresh", self.detect).pack(side="left", padx=8)

        ttk.Separator(frame).pack(fill="x", pady=16)
        ttk.Label(frame, textvariable=self.status, wraplength=660).pack(anchor="w")
        actions = ttk.Frame(frame)
        actions.pack(fill="x", pady=(16, 8))
        self.button(actions, "Install Peeper", lambda: self.start("install"), "Primary.TButton").pack(side="left")
        self.button(actions, "Update", lambda: self.start("update")).pack(side="left", padx=8)
        self.button(actions, "Repair", lambda: self.start("repair")).pack(side="left")
        self.button(actions, "Roll back", lambda: self.start("rollback")).pack(side="left", padx=8)
        self.button(actions, "Remove", lambda: self.start("remove")).pack(side="left")
        self.progress = ttk.Progressbar(frame, mode="indeterminate")
        self.progress.pack(fill="x", pady=(0, 10))
        self.details = tk.Text(frame, height=5, wrap="word", state="disabled", font=(family, 10),
                               background="white", foreground="#343449", borderwidth=1, relief="solid", padx=10, pady=8)
        footer = ttk.Frame(frame)
        footer.pack(side="bottom", fill="x", pady=(12, 0))
        ttk.Label(footer, text=f"Installer {VERSION} · Windows / Linux", style="Muted.TLabel").pack(side="left")
        self.button(footer, "Help", lambda: webbrowser.open(f"https://github.com/{core.REPOSITORY}/blob/main/docs/EASY-INSTALL.md")).pack(side="right")
        self.button(footer, "License", self.license).pack(side="right", padx=8)
        self.details.pack(fill="both", expand=True)
        # Respect desktop font/DPI differences and reserve footer space before
        # allowing the log to expand. A fixed height clips controls on Linux.
        root.update_idletasks()
        width = min(max(730, root.winfo_reqwidth()), root.winfo_screenwidth() - 80)
        height = min(max(610, root.winfo_reqheight()), root.winfo_screenheight() - 80)
        root.geometry(f"{width}x{height}")
        self.detect()
        root.after(100, self.poll)

    def button(self, parent, text, command, style="TButton"):
        button = ttk.Button(parent, text=text, command=command, style=style)
        self.buttons.append(button)
        return button

    def log(self, text: str):
        self.details.configure(state="normal")
        self.details.insert("end", text + "\n")
        self.details.see("end")
        self.details.configure(state="disabled")

    def detect(self):
        profiles = core.discover_profiles()
        self.chooser["values"] = [str(p) for p in profiles]
        if len(profiles) == 1:
            self.profile.set(str(profiles[0]))
        elif self.profile.get() not in self.chooser["values"]:
            self.profile.set("")
        self.refresh_status()

    def refresh_status(self):
        if not self.profile.get():
            self.status.set("Select your Vesktop installation above." if self.chooser["values"] else
                            "Vesktop wasn't found. Install it with Get Vesktop, open it once, quit it, then click Refresh.")
            return
        try:
            self.status.set(core.Installation(Path(self.profile.get())).status())
        except (core.InstallError, OSError, ValueError, KeyError, TypeError) as exc:
            self.status.set(f"Cannot read this installation: {exc}")

    def browse(self):
        chosen = filedialog.askdirectory(parent=self.root, title="Choose Vesktop's data folder (portable: choose Data)")
        if chosen:
            try:
                path = str(core.profile_path(Path(chosen)))
            except core.InstallError as exc:
                messagebox.showerror("Vesktop data folder", str(exc), parent=self.root)
                return
            self.chooser["values"] = list(dict.fromkeys([*self.chooser["values"], path]))
            self.profile.set(path)
            self.refresh_status()

    def start(self, action: str):
        if self.busy:
            return
        try:
            if not self.profile.get():
                raise core.InstallError("Select a Vesktop installation first. If none appears, install and launch Vesktop once, then click Refresh.")
            installation = core.Installation(Path(self.profile.get()), lambda line: self.events.put(("log", line)))
            core.ensure_closed()
            if action in {"install", "update", "repair"} and installation.custom_build_warning():
                if not messagebox.askyesno("Custom plugins detected", "This release includes ComfyPeeper and Vencord's standard plugins. Other custom plugins, such as Collector, will be unavailable while it is selected.\n\nYour current build is kept, and Remove restores it. Continue?", parent=self.root):
                    return
            if action == "remove" and not messagebox.askyesno("Remove Peeper?", "Restore your previous Vencord selection and remove the bundles installed by this app?\n\nYour login, settings, and saved workflow library will stay.", parent=self.root):
                return
            if action == "rollback" and not messagebox.askyesno("Restore previous release?", "Switch back to the previous Peeper release? Your settings and library will stay.", parent=self.root):
                return
        except (core.InstallError, OSError) as exc:
            messagebox.showerror("Cannot continue", str(exc), parent=self.root)
            return
        self.busy = True
        for button in self.buttons:
            button.configure(state="disabled")
        self.chooser.configure(state="disabled")
        self.progress.start(12)
        self.status.set("Working…")

        def worker():
            try:
                if action == "install":
                    installation.activate(core.bundled_payload())
                elif action == "update":
                    bundle = core.latest_bundle(installation.log)
                    info = installation.info()
                    if info.get("current", {}).get("sha256") == bundle.digest:
                        installation.repair()
                        installation.log("You have the latest release.")
                    else:
                        installation.activate(bundle)
                else:
                    {"repair": installation.repair, "rollback": installation.rollback, "remove": installation.uninstall}[action]()
                self.events.put(("done", "Done. You can open Vesktop now."))
            except Exception as exc:
                self.events.put(("error", str(exc)))

        threading.Thread(target=worker, name="peeper-install", daemon=False).start()

    def poll(self):
        try:
            while True:
                kind, text = self.events.get_nowait()
                self.log(text)
                if kind in {"done", "error"}:
                    self.busy = False
                    self.progress.stop()
                    for button in self.buttons:
                        button.configure(state="normal")
                    self.chooser.configure(state="readonly")
                    self.refresh_status()
                    if kind == "error":
                        messagebox.showerror("Peeper installation", text, parent=self.root)
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def license(self):
        messagebox.showinfo("About ComfyPeeper", "ComfyPeeper Installer · GPL-3.0-or-later\nCopyright 2026 ComfyPeeper contributors.\n\nContains a modified Vencord build. Source code and license notices are included with each release. This software comes without warranty.\n\nBundled runtime: Python, Tcl/Tk, psutil, certifi and PyInstaller. See THIRD-PARTY-NOTICES.txt in the release.", parent=self.root)

    def close(self):
        if self.busy:
            messagebox.showinfo("Installation in progress", "Please wait for the current operation to finish before closing the installer.", parent=self.root)
        else:
            self.root.destroy()


def self_test(output: Path | None = None):
    """Exercise the packaged payload and real filesystem code in isolation."""
    bundle = core.bundled_payload()
    with tempfile.TemporaryDirectory(prefix="peeper-selftest-") as temp:
        profile = Path(temp) / "vesktop"
        profile.mkdir()
        core.atomic_write(profile / "state.json", core.encode_object({"windowBounds": {"width": 1234}}))
        installation = core.Installation(profile)
        original_check = core.ensure_closed
        try:
            # The fake profile cannot conflict with the user's running Vesktop.
            core.ensure_closed = lambda: None
            installation.activate(bundle)
            assert "installed and enabled" in installation.status()
            installation.repair()
            assert "installed and enabled" in installation.status()
            installation.uninstall()
            assert "vencordDir" not in core.read_object(profile / "state.json")
            assert core.read_object(profile / "state.json")["windowBounds"]["width"] == 1234
        finally:
            core.ensure_closed = original_check
    root = tk.Tk()
    root.withdraw()
    InstallerWindow(root)
    root.update()
    root.destroy()
    result = f"PASS: bundle {bundle.version}, install, repair, uninstall, preserved state, Tk UI\n"
    if output:
        output.write_text(result, encoding="utf-8")
    if sys.stdout:
        print(result, end="")


def main():
    parser = argparse.ArgumentParser(description="ComfyPeeper graphical installer for Vesktop")
    parser.add_argument("--self-test", action="store_true", help="Test the packaged payload with a temporary profile")
    parser.add_argument("--test-output", type=Path, help="Write the self-test result to this file")
    parser.add_argument("--version", action="version", version=VERSION)
    args = parser.parse_args()
    if args.self_test:
        self_test(args.test_output)
        return
    root = tk.Tk()
    InstallerWindow(root)
    root.mainloop()


if __name__ == "__main__":
    main()
