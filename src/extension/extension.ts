// *****************************************************************************
// Copyright(c) 2026 MASA Group
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// *****************************************************************************

import * as vscode from "vscode"
import { EcoreEditorProvider, VIEW_TYPE } from "./ecoreEditorProvider"

const EMPTY_MODEL = (name: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<ecore:EPackage xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:ecore="http://www.eclipse.org/emf/2002/Ecore" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="${name}" nsURI="http://www.example.org/${name}" nsPrefix="${name}"/>
`

export function activate(context: vscode.ExtensionContext): void {
    const provider = EcoreEditorProvider.register(context)

    context.subscriptions.push(
        vscode.commands.registerCommand("ecorium.openWithEcorium", async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri
            if (!target) return
            await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE)
        }),
        vscode.commands.registerCommand("ecorium.openAsText", async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.tabGroups.activeTabGroup.activeTab?.input
            const resolved = target instanceof vscode.Uri ? target : (target as { uri?: vscode.Uri } | undefined)?.uri
            if (!resolved) return
            await provider.openAsText(resolved)
        }),
        vscode.commands.registerCommand("ecorium.reload", (uri?: vscode.Uri) => {
            const target = uri ?? (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined)?.uri
            provider.reload(target)
        }),
        vscode.commands.registerCommand("ecorium.newModel", async () => {
            const folder = vscode.workspace.workspaceFolders?.[0]?.uri
            const location = await vscode.window.showSaveDialog({
                defaultUri: folder ? vscode.Uri.joinPath(folder, "model.ecore") : undefined,
                filters: { "Ecore model": ["ecore"] },
                title: "New Ecore Model"
            })
            if (!location) return
            const base = location.path.split("/").pop()?.replace(/\.ecore$/i, "") || "model"
            const name = base.replace(/[^A-Za-z0-9_]/g, "_")
            await vscode.workspace.fs.writeFile(location, new TextEncoder().encode(EMPTY_MODEL(name)))
            await vscode.commands.executeCommand("vscode.openWith", location, VIEW_TYPE)
        })
    )
}

export function deactivate(): void {}
