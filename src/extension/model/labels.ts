// *****************************************************************************
// Copyright(c) 2026 MASA Group
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// *****************************************************************************

import {
    isEAttribute,
    isEClass,
    isENamedElement,
    isEPackage,
    isEReference,
    type EAnnotation,
    type EClass,
    type EClassifier,
    type EEnumLiteral,
    type EObject,
    type EOperation,
    type EParameter,
    type ETypedElement
} from "@masagroup/ecore"

const ICONS: Record<string, string> = {
    EPackage: "package",
    EClass: "class",
    EAttribute: "attribute",
    EReference: "reference",
    EOperation: "operation",
    EParameter: "parameter",
    EEnum: "enum",
    EEnumLiteral: "literal",
    EDataType: "datatype",
    EAnnotation: "annotation",
    EStringToStringMapEntry: "entry",
    ETypeParameter: "typeparam",
    EGenericType: "generic"
}

export function iconFor(eObject: EObject): string {
    return ICONS[eObject.eClass().getName()] ?? "object"
}

function typeName(e: ETypedElement): string {
    try {
        const t = e.getEType()
        return t ? (t.getName() ?? "?") : ""
    } catch {
        return "?"
    }
}

export function multiplicity(e: ETypedElement): string {
    const lower = e.getLowerBound()
    const upper = e.getUpperBound()
    if (lower === 0 && upper === 1) return ""
    const up = upper < 0 ? "*" : String(upper)
    return `[${lower}..${up}]`
}

/** Human readable label, close to what the EMF sample editor shows. */
export function labelFor(eObject: EObject): string {
    const eClass = eObject.eClass()
    const kind = eClass.getName()
    switch (kind) {
        case "EClass": {
            const c = eObject as EClass
            const supers = c
                .getESuperTypes()
                .toArray()
                .map((s) => s?.getName() ?? "?")
            return (c.getName() ?? "") + (supers.length ? " -> " + supers.join(", ") : "")
        }
        case "EAttribute":
        case "EReference":
        case "EParameter": {
            const t = eObject as ETypedElement
            const tn = typeName(t)
            return (t.getName() ?? "") + (tn ? " : " + tn : "")
        }
        case "EOperation": {
            const op = eObject as EOperation
            const params = op
                .getEParameters()
                .toArray()
                .map((p: EParameter) => `${p.getName() ?? ""} : ${typeName(p)}`)
            const tn = typeName(op)
            return `${op.getName() ?? ""}(${params.join(", ")})` + (tn ? " : " + tn : "")
        }
        case "EEnumLiteral": {
            const l = eObject as EEnumLiteral
            return `${l.getName() ?? ""} = ${l.getValue()}`
        }
        case "EDataType": {
            const d = eObject as EClassifier
            const itn = d.getInstanceClassName()
            return (d.getName() ?? "") + (itn ? ` [${itn}]` : "")
        }
        case "EAnnotation":
            return (eObject as EAnnotation).getSource() ?? ""
        case "EStringToStringMapEntry": {
            const key = eObject.eGet(eClass.getEStructuralFeatureFromName("key"))
            const value = eObject.eGet(eClass.getEStructuralFeatureFromName("value"))
            return `${key ?? ""} -> ${value ?? ""}`
        }
    }
    if (isENamedElement(eObject)) return eObject.getName() ?? ""
    return kind
}

export function detailFor(eObject: EObject): string | undefined {
    if (isEAttribute(eObject) || isEReference(eObject)) {
        const parts = [multiplicity(eObject)]
        if (isEReference(eObject) && eObject.isContainment()) parts.push("containment")
        if (isEAttribute(eObject) && eObject.isID()) parts.push("id")
        return parts.filter(Boolean).join(" ") || undefined
    }
    if (isEPackage(eObject)) return eObject.getNsURI() || undefined
    if (isEClass(eObject)) {
        if (eObject.isInterface()) return "interface"
        if (eObject.isAbstract()) return "abstract"
    }
    return undefined
}

/** "nsURI" -> "Ns URI", "eSuperTypes" -> "ESuper Types", "lowerBound" -> "Lower Bound". */
export function featureLabel(name: string): string {
    if (!name) return name
    let out = name[0].toUpperCase()
    for (let i = 1; i < name.length; i++) {
        const c = name[i]
        const prev = name[i - 1]
        const isUpper = c !== c.toLowerCase() && c === c.toUpperCase()
        const prevUpper = prev !== prev.toLowerCase() && prev === prev.toUpperCase()
        const keepAttached = i === 1 && name[0] === "e" // "eType" -> "EType"
        if (isUpper && !prevUpper && !keepAttached) out += " "
        out += c
    }
    return out
}

/** Default name for a freshly created named element. */
export function defaultName(eClassName: string): string {
    switch (eClassName) {
        case "EPackage":
            return "newPackage"
        case "EClass":
            return "NewClass"
        case "EDataType":
            return "NewDataType"
        case "EEnum":
            return "NewEnum"
        case "EEnumLiteral":
            return "newLiteral"
        case "EAttribute":
            return "newAttribute"
        case "EReference":
            return "newReference"
        case "EOperation":
            return "newOperation"
        case "EParameter":
            return "newParameter"
        case "ETypeParameter":
            return "T"
    }
    return "new" + eClassName.replace(/^E(?=[A-Z])/, "")
}
