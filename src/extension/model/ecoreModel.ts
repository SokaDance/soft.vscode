// *****************************************************************************
// Copyright(c) 2026 MASA Group
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// *****************************************************************************

import {
    EResourceSetImpl,
    EcoreUtils,
    URI,
    getEcorePackage,
    getPackageRegistry,
    isEAttribute,
    isEClass,
    isEDataType,
    isEEnum,
    isENamedElement,
    isEReference,
    type EAttribute,
    type EClass,
    type EDataType,
    type EList,
    type EObject,
    type EPackage,
    type EReference,
    type EResource,
    type EResourceSet,
    type EStructuralFeature,
    type ETypedElement
} from "@masagroup/ecore"
import type {
    ChildOption,
    EditCommand,
    ExternalPackage,
    ModelDiagnostic,
    ModelSnapshot,
    ObjectProperties,
    PropertyDescriptor,
    PropertyInput,
    Ref,
    TreeNode
} from "../../shared/protocol"
import { defaultName, detailFor, featureLabel, iconFor, labelFor } from "./labels"

function isETypedElement(obj: EObject): obj is ETypedElement {
    return typeof (obj as Partial<ETypedElement>).getEType === "function"
}

/** The package registered for `nsURI` (Ecore itself, or a package of the global registry), if any. */
export function registeredPackage(nsURI: string): EPackage | null {
    return nsURI === ECORE_NS_URI ? getEcorePackage() : getPackageRegistry().getPackage(nsURI)
}

/** XMI text of a registered package, so it can be shown like a .ecore file. */
export function serializePackage(pkg: EPackage): string {
    const resourceSet = new EResourceSetImpl()
    const resource = resourceSet.createResource(new URI(`ecorium-package:/${pkg.getName()}.ecore`))
    const copy = EcoreUtils.copy(pkg)
    // a built-in operation without type keeps eType explicitly set to null, which would be written as
    // <eType xsi:nil="true"/> and confuse the decoder; an unset eType is simply omitted
    const unsetNullTypes = (obj: EObject) => {
        if (isETypedElement(obj) && !obj.getEType()) {
            const eType = obj.eClass().getEStructuralFeatureFromName("eType")
            if (eType && obj.eIsSet(eType)) obj.eUnset(eType)
        }
        for (const child of obj.eContents()) unsetNullTypes(child)
    }
    unsetNullTypes(copy)
    resource.eContents().add(copy)
    return resource.saveToString()
}

export interface ApplyResult {
    /** Object to select after the edit (null to clear the selection). */
    selectId?: string | null
}

export interface EcoreModelOptions {
    autoName?: boolean
    /** Refuse every edit, with this explanation (e.g. a package built into Ecorium). */
    readOnlyReason?: string
}

const ECORE_NS_URI = "http://www.eclipse.org/emf/2002/Ecore"

/**
 * In-memory Ecore model of one document, backed by Soft TS.
 *
 * Objects are addressed by small, session-stable ids (`o1`, `o2`, ...). When the text is reloaded
 * (undo, external edit), ids are re-attached to the objects having the same URI fragment, so the
 * selection and expansion state of the UI survive a reload.
 */
export class EcoreModel {
    private resourceSet: EResourceSet
    private resource: EResource
    private idOf = new Map<EObject, string>()
    private objectOf = new Map<string, EObject>()
    private nextId = 1
    private diagnostics: ModelDiagnostic[] = []
    private fatal: ModelDiagnostic | undefined
    private hasGoodModel = false
    /** Resources added by hand (kept when the resource set is rebuilt). */
    private addedPackages = new Set<string>()
    autoName: boolean
    readonly readOnlyReason: string | undefined

    constructor(
        private readonly uri: URI,
        options: EcoreModelOptions = {}
    ) {
        this.autoName = options.autoName ?? true
        this.readOnlyReason = options.readOnlyReason
        this.resourceSet = new EResourceSetImpl()
        this.resource = this.resourceSet.createResource(uri)
    }

    // ---------------------------------------------------------------------------------------------
    // Loading / saving
    // ---------------------------------------------------------------------------------------------

    /** Parses `text`. Returns true when the text is usable (possibly with non fatal diagnostics). */
    load(text: string): boolean {
        const previous = new Map<string, string>()
        for (const [obj, id] of this.idOf) previous.set(this.safeFragment(obj), id)

        const resource = this.resourceSet.createResource(this.uri)
        let fatal: ModelDiagnostic | undefined
        try {
            resource.loadFromString(text)
            // since @masagroup/ecore 1.8, a malformed document is the first error of the resource
            // (decoding stops there) instead of an exception
            const malformed = resource.getErrors().toArray().find((e) => isXmlSyntaxError(e.message))
            if (malformed) fatal = toFatalDiagnostic(malformed.message)
        } catch (e) {
            fatal = toFatalDiagnostic(e instanceof Error ? e.message : String(e))
        }

        if (fatal && this.hasGoodModel) {
            // keep the last good model, just flag the problem
            this.resourceSet.getResources().remove(resource)
            this.fatal = fatal
            return false
        }

        this.resourceSet.getResources().remove(this.resource)
        this.resource = resource
        this.fatal = fatal
        this.hasGoodModel = !fatal
        this.diagnostics = collectDiagnostics(resource)
        this.rebuildIds(previous)
        return !fatal
    }

    /** Drops every cached resource (cross references to other files) and reloads `text`. */
    reset(text: string): boolean {
        const previous = new Map<string, string>()
        for (const [obj, id] of this.idOf) previous.set(this.safeFragment(obj), id)
        this.resourceSet = new EResourceSetImpl()
        this.resource = this.resourceSet.createResource(this.uri)
        this.hasGoodModel = false
        this.idOf.clear()
        this.objectOf.clear()
        const ok = this.load(text)
        if (previous.size) this.rebuildIds(previous)
        for (const uri of [...this.addedPackages]) {
            try {
                this.addExternalPackage(uri)
            } catch {
                this.addedPackages.delete(uri)
            }
        }
        return ok
    }

    // ---------------------------------------------------------------------------------------------
    // External packages
    // ---------------------------------------------------------------------------------------------

    /** Packages outside the document: the loaded resources of the set, plus the built-in ones the document points to. */
    externalPackages(): ExternalPackage[] {
        const referenced = this.referencedResources()
        const list: ExternalPackage[] = []
        const seen = new Set<string>()
        for (const r of this.resourceSet.getResources()) {
            if (r === this.resource) continue
            const uri = r.getURI().toString()
            seen.add(uri)
            const names = r
                .eContents()
                .toArray()
                .filter(isENamedElement)
                .map((o) => o.getName() ?? "")
                .filter(Boolean)
            const missing = !r.isLoaded() || (r.eContents().isEmpty() && !r.getErrors().isEmpty())
            list.push({ uri, path: readablePath(uri), label: missing ? "(not found)" : names.join(", ") || "(empty)", referenced: referenced.has(uri), missing })
        }
        for (const uri of referenced) {
            if (seen.has(uri)) continue
            const pkg = registeredPackage(uri)
            if (pkg) list.push({ uri, path: uri, label: pkg.getName() ?? uri, referenced: true, builtin: true })
        }
        return list.sort((a, b) => a.path.localeCompare(b.path))
    }

    /** Loads `uri` into the resource set so its elements become reference candidates. */
    addExternalPackage(uri: string): void {
        if (uri === this.uri.toString()) throw new Error("This is the edited document itself")
        const existing = this.findResource(uri)
        if (existing?.isLoaded() && !existing.eContents().isEmpty()) {
            this.addedPackages.add(uri)
            return
        }
        let resource: EResource | undefined
        try {
            resource = this.resourceSet.getResource(new URI(uri), true)
        } catch (e) {
            const created = this.findResource(uri)
            if (created) this.resourceSet.getResources().remove(created)
            throw new Error(`Cannot load '${readablePath(uri)}': ${e instanceof Error ? e.message : String(e)}`)
        }
        if (!resource || !resource.isLoaded() || resource.eContents().isEmpty()) {
            if (resource) this.resourceSet.getResources().remove(resource)
            const first = resource?.getErrors().toArray()[0]
            throw new Error(`Cannot load '${readablePath(uri)}'${first ? ": " + first.message : ""}`)
        }
        this.addedPackages.add(uri)
    }

    /** Forgets the resource at `uri`; refused while an element of the document points into it. */
    removeExternalPackage(uri: string): void {
        if (this.referencedResources().has(uri)) throw new Error(`'${readablePath(uri)}' is referenced by this file and cannot be removed`)
        const resource = this.findResource(uri)
        if (resource) this.resourceSet.getResources().remove(resource)
        this.addedPackages.delete(uri)
    }

    private findResource(uri: string): EResource | undefined {
        return this.resourceSet
            .getResources()
            .toArray()
            .find((r) => r.getURI().toString() === uri)
    }

    /** URIs of the resources (and built-in packages) that elements of the document point to. */
    private referencedResources(): Set<string> {
        const uris = new Set<string>()
        try {
            EcoreUtils.resolveAllInResource(this.resource)
        } catch {
            // a dangling reference stays a proxy; it still names its resource below
        }
        const visit = (obj: EObject) => {
            for (const target of obj.eCrossReferences()) {
                if (!target) continue
                const uri = target.eIsProxy() ? EcoreUtils.getURI(target) : target.eResource()?.getURI()
                if (!uri) continue
                const text = uri.toString()
                const ndx = text.indexOf("#")
                const resourceUri = ndx >= 0 ? text.slice(0, ndx) : text
                if (resourceUri !== this.uri.toString()) uris.add(resourceUri)
            }
            for (const [, child] of contents(obj)) visit(child)
        }
        for (const root of this.resource.eContents()) visit(root)
        return uris
    }

    serialize(): string {
        return this.resource.saveToString()
    }

    getDiagnostics(): ModelDiagnostic[] {
        return this.fatal ? [this.fatal, ...this.diagnostics] : this.diagnostics
    }

    getFatal(): ModelDiagnostic | undefined {
        return this.fatal
    }

    /** Editing is refused while the text is broken or contains constructs Soft TS cannot round-trip. */
    isReadOnly(): boolean {
        return !!this.readOnlyReason || !!this.fatal || this.diagnostics.some((d) => d.severity === "error")
    }

    /** Id of the object at `fragment` (e.g. "//Library/name"), if any. */
    idForFragment(fragment: string): string | undefined {
        try {
            const obj = this.resource.getEObject(fragment)
            return obj ? this.idOf.get(obj) : undefined
        } catch {
            return undefined
        }
    }

    isEmpty(): boolean {
        return this.resource.eContents().isEmpty()
    }

    // ---------------------------------------------------------------------------------------------
    // Snapshot for the tree
    // ---------------------------------------------------------------------------------------------

    snapshot(): ModelSnapshot {
        const roots = this.resource
            .eContents()
            .toArray()
            .map((o) => this.node(o, undefined))
        return {
            roots,
            childOptions: this.childOptions(),
            rootOptions: this.rootOptions(),
            diagnostics: this.diagnostics,
            fatal: this.fatal,
            readOnlyReason: this.readOnlyReason,
            externalPackages: this.externalPackages()
        }
    }

    private node(obj: EObject, feature: string | undefined): TreeNode {
        const children: TreeNode[] = []
        for (const [f, child] of contents(obj)) children.push(this.node(child, f.getName()))
        const node: TreeNode = {
            id: this.id(obj),
            eClass: obj.eClass().getName(),
            icon: iconFor(obj),
            label: labelFor(obj),
            feature,
            children
        }
        const detail = detailFor(obj)
        if (detail) node.detail = detail
        if (isEClass(obj) && (obj.isAbstract() || obj.isInterface())) node.abstract = true
        const typeId = this.declarationIdOf(obj)
        if (typeId) node.typeId = typeId
        return node
    }

    /**
     * Declaration a node points to: the eType of a typed element, or the first super type of a class.
     * A local id, or "uri:<absolute uri>" when it lives in another resource.
     */
    private declarationIdOf(obj: EObject): string | undefined {
        let target: EObject | null | undefined
        if (isEClass(obj)) target = obj.getESuperTypes().isEmpty() ? null : obj.getESuperTypes().get(0)
        else if (isETypedElement(obj)) target = obj.getEType()
        if (!target) return undefined
        return this.idOf.get(target) ?? "uri:" + EcoreUtils.getURI(target).toString()
    }

    private childOptions(): Record<string, ChildOption[]> {
        const result: Record<string, ChildOption[]> = {}
        for (const obj of this.idOf.keys()) {
            const eClass = obj.eClass()
            const name = eClass.getName()
            if (result[name]) continue
            const options: ChildOption[] = []
            for (const f of eClass.getEAllContainments()) {
                if (f.isTransient() || f.isDerived() || !f.isChangeable()) continue
                for (const c of concreteSubClasses(f.getEReferenceType())) {
                    options.push({
                        feature: f.getName(),
                        nsURI: c.getEPackage().getNsURI(),
                        eClass: c.getName(),
                        label: c.getName()
                    })
                }
            }
            result[name] = options
        }
        return result
    }

    private rootOptions(): ChildOption[] {
        const ecore = getEcorePackage()
        const options = concreteSubClasses(ecore.getEObject()).map((c) => ({
            feature: "",
            nsURI: c.getEPackage().getNsURI(),
            eClass: c.getName(),
            label: c.getName()
        }))
        options.sort((a, b) => (a.eClass === "EPackage" ? -1 : b.eClass === "EPackage" ? 1 : a.label.localeCompare(b.label)))
        return options
    }

    // ---------------------------------------------------------------------------------------------
    // Properties
    // ---------------------------------------------------------------------------------------------

    properties(id: string): ObjectProperties | null {
        const obj = this.objectOf.get(id)
        if (!obj) return null
        const props: PropertyDescriptor[] = []
        for (const f of obj.eClass().getEAllStructuralFeatures()) {
            if (f.isDerived() || f.isTransient() || f.isVolatile()) continue
            if (isEReference(f)) {
                if (f.isContainment() || f.isContainer()) continue
                props.push(this.referenceProperty(obj, f))
            } else if (isEAttribute(f)) {
                const p = this.attributeProperty(obj, f)
                if (p) props.push(p)
            }
        }
        const nameIndex = props.findIndex((p) => p.feature === "name")
        if (nameIndex > 0) props.unshift(...props.splice(nameIndex, 1))
        return {
            id,
            eClass: obj.eClass().getName(),
            label: labelFor(obj),
            icon: iconFor(obj),
            fragment: this.safeFragment(obj),
            props
        }
    }

    private attributeProperty(obj: EObject, f: EAttribute): PropertyDescriptor | undefined {
        const type = f.getEAttributeType()
        if (!type) return undefined
        const input = inputFor(type)
        if (!input) return undefined
        const raw = obj.eGet(f)
        const value = f.isMany()
            ? (raw as EList<unknown>).toArray().map((v) => toLiteral(type, v))
            : toLiteral(type, raw)
        const descriptor: PropertyDescriptor = {
            feature: f.getName(),
            label: featureLabel(f.getName()),
            kind: "attribute",
            many: f.isMany(),
            changeable: f.isChangeable(),
            input,
            typeName: type.getName(),
            value
        }
        if (input === "enum" && isEEnum(type)) {
            descriptor.literals = type
                .getELiterals()
                .toArray()
                .map((l) => l.getLiteral() || l.getName())
        }
        return descriptor
    }

    private referenceProperty(obj: EObject, f: EReference): PropertyDescriptor {
        const type = f.getEReferenceType()
        let accept: (o: EObject) => boolean = (o) => isSubTypeOf(o.eClass(), type)
        if (f.getName() === "eType") {
            // EMF constraint: attributes are typed by data types, references by classes
            if (isEAttribute(obj)) accept = (o) => isEDataType(o)
            else if (isEReference(obj)) accept = (o) => isEClass(o)
        }
        const raw = obj.eGetResolve(f, true)
        const value = f.isMany()
            ? (raw as EList<EObject>).toArray().map((o) => this.ref(o))
            : raw
              ? this.ref(raw as EObject)
              : null
        return {
            feature: f.getName(),
            label: featureLabel(f.getName()),
            kind: "reference",
            many: f.isMany(),
            changeable: f.isChangeable(),
            input: "reference",
            typeName: type.getName(),
            candidates: this.candidates(accept),
            value
        }
    }

    private candidates(accept: (o: EObject) => boolean): Ref[] {
        const local: Ref[] = []
        for (const obj of this.idOf.keys()) if (accept(obj)) local.push(this.ref(obj))

        const external: Ref[] = []
        const seen = new Set<EObject>()
        const visit = (root: EObject) => {
            if (seen.has(root)) return
            seen.add(root)
            if (accept(root)) external.push(this.ref(root))
            for (const [, child] of contents(root)) visit(child)
        }
        visit(getEcorePackage())
        for (const r of this.resourceSet.getResources()) {
            if (r === this.resource) continue
            for (const root of r.eContents()) visit(root)
        }
        external.sort((a, b) => a.label.localeCompare(b.label))
        return [...local, ...external]
    }

    private ref(obj: EObject): Ref {
        const id = this.idOf.get(obj)
        const name = isENamedElement(obj) ? (obj.getName() ?? "") : labelFor(obj)
        if (id) return { id, label: name, detail: this.safeFragment(obj) }
        if (obj.eIsProxy()) {
            const uri = EcoreUtils.getURI(obj).toString()
            return { id: "uri:" + uri, label: `${name || "?"} (unresolved)`, detail: uri }
        }
        const uri = EcoreUtils.getURI(obj).toString()
        return { id: "uri:" + uri, label: `${name} (${originOf(obj)})`, detail: uri }
    }

    // ---------------------------------------------------------------------------------------------
    // Edits
    // ---------------------------------------------------------------------------------------------

    apply(cmd: EditCommand): ApplyResult {
        switch (cmd.type) {
            case "set": {
                const obj = this.object(cmd.id)
                const f = this.attribute(obj, cmd.feature)
                if (cmd.value === null || cmd.value === "") {
                    obj.eUnset(f)
                } else {
                    const value = fromLiteral(f.getEAttributeType(), cmd.value)
                    // setting the default back means "not set": keeps the XMI minimal, like EMF does
                    if (!f.isUnsettable() && value === f.getDefaultValue()) obj.eUnset(f)
                    else obj.eSet(f, value)
                }
                return { selectId: cmd.id }
            }
            case "setMany": {
                const obj = this.object(cmd.id)
                const f = this.attribute(obj, cmd.feature)
                const type = f.getEAttributeType()
                const values = cmd.values.map((v) => fromLiteral(type, v))
                const list = obj.eGet(f) as EList<unknown>
                list.clear()
                for (const v of values) list.add(v)
                return { selectId: cmd.id }
            }
            case "setRef": {
                const obj = this.object(cmd.id)
                const f = this.reference(obj, cmd.feature)
                // note: eSet(null) rather than eUnset, which is a no-op for eType in Soft TS 1.7
                obj.eSet(f, cmd.target === null ? null : this.target(cmd.target))
                return { selectId: cmd.id }
            }
            case "setRefs": {
                const obj = this.object(cmd.id)
                const f = this.reference(obj, cmd.feature)
                const targets = cmd.targets.map((t) => this.target(t))
                const list = obj.eGet(f) as EList<EObject>
                list.clear()
                for (const t of targets) list.add(t)
                return { selectId: cmd.id }
            }
            case "create":
                return { selectId: this.create(cmd.parentId, cmd.feature, cmd.nsURI, cmd.eClass, cmd.index) }
            case "delete":
                return { selectId: this.delete(cmd.id) }
            case "move": {
                const obj = this.object(cmd.id)
                const list = this.containingList(obj)
                const from = list.indexOf(obj)
                const to = Math.max(0, Math.min(list.size() - 1, from + cmd.delta))
                if (from !== to) list.moveTo(from, to)
                return { selectId: cmd.id }
            }
        }
    }

    private create(parentId: string | null, featureName: string | undefined, nsURI: string, className: string, index?: number): string {
        const eClass = this.resolveClass(nsURI, className)
        const obj = eClass.getEPackage().getEFactoryInstance().create(eClass)
        let siblings: EList<EObject>
        if (parentId === null) {
            siblings = this.resource.eContents()
        } else {
            const parent = this.object(parentId)
            if (!featureName) throw new Error("Missing containment feature")
            const f = this.reference(parent, featureName)
            if (!f.isContainment()) throw new Error(`Feature '${featureName}' is not a containment`)
            if (!f.isMany()) {
                if (this.autoName && isENamedElement(obj)) obj.setName(defaultName(className))
                parent.eSet(f, obj)
                this.register(obj)
                return this.id(obj)
            }
            siblings = parent.eGet(f) as EList<EObject>
        }
        if (this.autoName && isENamedElement(obj)) obj.setName(uniqueName(defaultName(className), siblings))
        if (index !== undefined && index >= 0 && index < siblings.size()) siblings.insert(index, obj)
        else siblings.add(obj)
        this.register(obj)
        return this.id(obj)
    }

    private delete(id: string): string | null {
        const obj = this.object(id)
        const parent = obj.eContainer()
        const removed = new Set<EObject>([obj])
        for (const o of allContents(obj)) removed.add(o)

        // drop dangling cross references held by the surviving objects
        for (const other of this.idOf.keys()) {
            if (removed.has(other)) continue
            for (const f of other.eClass().getEAllReferences()) {
                if (f.isContainment() || f.isContainer() || f.isDerived() || !f.isChangeable()) continue
                if (f.isMany()) {
                    const list = other.eGetResolve(f, false) as EList<EObject>
                    for (let i = list.size() - 1; i >= 0; i--) if (removed.has(list.get(i))) list.removeAt(i)
                } else if (removed.has(other.eGetResolve(f, false) as EObject)) {
                    other.eSet(f, null)
                }
            }
        }
        EcoreUtils.remove(obj)
        for (const o of removed) {
            const oid = this.idOf.get(o)
            if (oid) this.objectOf.delete(oid)
            this.idOf.delete(o)
        }
        return parent ? this.id(parent) : null
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    getParentId(id: string): string | null {
        const parent = this.objectOf.get(id)?.eContainer()
        return parent ? (this.idOf.get(parent) ?? null) : null
    }

    private id(obj: EObject): string {
        let id = this.idOf.get(obj)
        if (!id) {
            id = "o" + this.nextId++
            this.idOf.set(obj, id)
            this.objectOf.set(id, obj)
        }
        return id
    }

    private register(obj: EObject) {
        this.id(obj)
        for (const o of allContents(obj)) this.id(o)
    }

    private rebuildIds(previous: Map<string, string>) {
        this.idOf.clear()
        this.objectOf.clear()
        const visit = (obj: EObject) => {
            const fragment = this.safeFragment(obj)
            const id = previous.get(fragment) ?? "o" + this.nextId++
            this.idOf.set(obj, id)
            this.objectOf.set(id, obj)
            for (const [, child] of contents(obj)) visit(child)
        }
        for (const root of this.resource.eContents()) visit(root)
    }

    private safeFragment(obj: EObject): string {
        try {
            return this.resource.getURIFragment(obj)
        } catch {
            return ""
        }
    }

    private object(id: string): EObject {
        const obj = this.objectOf.get(id)
        if (!obj) throw new Error(`Unknown object '${id}' (the model may have been reloaded)`)
        return obj
    }

    private feature(obj: EObject, name: string): EStructuralFeature {
        const f = obj.eClass().getEStructuralFeatureFromName(name)
        if (!f) throw new Error(`Unknown feature '${name}' on ${obj.eClass().getName()}`)
        if (!f.isChangeable()) throw new Error(`Feature '${name}' is read-only`)
        return f
    }

    private attribute(obj: EObject, name: string): EAttribute {
        const f = this.feature(obj, name)
        if (!isEAttribute(f)) throw new Error(`Feature '${name}' is not an attribute`)
        return f
    }

    private reference(obj: EObject, name: string): EReference {
        const f = this.feature(obj, name)
        if (!isEReference(f)) throw new Error(`Feature '${name}' is not a reference`)
        return f
    }

    private target(ref: string): EObject {
        if (ref.startsWith("uri:")) {
            const obj = this.resourceSet.getEObject(new URI(ref.slice(4)), true)
            if (!obj) throw new Error(`Cannot resolve '${ref.slice(4)}'`)
            return obj
        }
        return this.object(ref)
    }

    private containingList(obj: EObject): EList<EObject> {
        const container = obj.eContainer()
        if (!container) return this.resource.eContents()
        const f = obj.eContainmentFeature()
        if (!f.isMany()) throw new Error("Cannot move an object held by a single valued containment")
        return container.eGet(f) as EList<EObject>
    }

    private resolveClass(nsURI: string, name: string): EClass {
        let pkg: EPackage | null = nsURI === ECORE_NS_URI ? getEcorePackage() : this.resourceSet.getPackageRegistry().getPackage(nsURI)
        if (!pkg && nsURI) {
            // a package defined by a resource of the set (e.g. the edited document itself)
            for (const r of this.resourceSet.getResources()) {
                for (const root of r.eContents()) {
                    const found = findPackage(root, nsURI)
                    if (found) pkg = found
                }
            }
        }
        if (!pkg) throw new Error(`Unknown package '${nsURI}'`)
        const c = pkg.getEClassifier(name)
        if (!c || !isEClass(c)) throw new Error(`Unknown class '${name}' in package '${nsURI}'`)
        if (c.isAbstract()) throw new Error(`Class '${name}' is abstract`)
        return c
    }
}

// -------------------------------------------------------------------------------------------------
// Module helpers
// -------------------------------------------------------------------------------------------------

/** Non transient containment children of `obj`, in feature order. */
export function* contents(obj: EObject): Generator<[EReference, EObject]> {
    for (const f of obj.eClass().getEAllContainments()) {
        if (f.isTransient() || f.isDerived()) continue
        const v = obj.eGetResolve(f, false)
        if (!v) continue
        if (f.isMany()) {
            for (const child of v as EList<EObject>) if (child) yield [f, child]
        } else {
            yield [f, v as EObject]
        }
    }
}

function* allContents(obj: EObject): Generator<EObject> {
    for (const [, child] of contents(obj)) {
        yield child
        yield* allContents(child)
    }
}

function findPackage(root: EObject, nsURI: string): EPackage | null {
    if (isEPackageLike(root)) {
        if (root.getNsURI() === nsURI) return root
        for (const sub of root.getESubPackages()) {
            const found = findPackage(sub, nsURI)
            if (found) return found
        }
    }
    return null
}

function isEPackageLike(o: EObject): o is EPackage {
    return o.eClass().getName() === "EPackage" && "getNsURI" in o
}

function concreteSubClasses(type: EClass): EClass[] {
    const packages = new Set<EPackage>([getEcorePackage()])
    const typePackage = type.getEPackage()
    if (typePackage) packages.add(typePackage)
    const result: EClass[] = []
    for (const pkg of packages) {
        for (const c of pkg.getEClassifiers()) {
            if (isEClass(c) && !c.isAbstract() && !c.isInterface() && isSubTypeOf(c, type)) result.push(c)
        }
    }
    return result
}

/** Like EClass.isSuperTypeOf, but treats EObject as the implicit root of every class (Soft TS does not). */
function isSubTypeOf(eClass: EClass, type: EClass): boolean {
    return type === getEcorePackage().getEObject() || type.isSuperTypeOf(eClass)
}

function uniqueName(base: string, siblings: EList<EObject>): string {
    const names = new Set<string>()
    for (const s of siblings) if (isENamedElement(s)) names.add(s.getName())
    if (!names.has(base)) return base
    for (let i = 1; ; i++) {
        const candidate = base + i
        if (!names.has(candidate)) return candidate
    }
}

/** A file URI as a path ("D:/models/types.ecore"); other URIs unchanged. */
export function readablePath(uri: string): string {
    if (!uri.startsWith("file:")) return uri
    let path = uri.replace(/^file:\/\//, "")
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
    try {
        return decodeURIComponent(path)
    } catch {
        return path
    }
}

function originOf(obj: EObject): string {
    const resource = obj.eResource()
    if (!resource) return "external"
    const uri = resource.getURI()
    if (uri.toString() === ECORE_NS_URI) return "Ecore"
    const path = uri.path || uri.toString()
    const ndx = path.lastIndexOf("/")
    return ndx >= 0 ? path.slice(ndx + 1) : path
}

const NUMBER_TYPES = new Set([
    "number",
    "float64",
    "java.lang.Double",
    "double",
    "float32",
    "java.lang.Float",
    "float",
    "int",
    "java.lang.Integer",
    "int32",
    "int16",
    "java.lang.Short",
    "short",
    "int8",
    "byte"
])
const BIG_TYPES = new Set(["uint64", "int64", "java.lang.Long", "long", "bigint", "BigInt", "java.math.BigInteger", "java.math.BigDecimal"])
const BOOLEAN_TYPES = new Set(["boolean", "bool", "java.lang.Boolean"])
const STRING_TYPES = new Set(["string", "java.lang.String", "Date", "java.util.Date", "EDate", "char", "java.lang.Character"])

function instanceType(type: EDataType): string {
    return type.getInstanceTypeName() || type.getInstanceClassName() || ""
}

function inputFor(type: EDataType): PropertyInput | undefined {
    if (isEEnum(type)) return "enum"
    const itn = instanceType(type)
    if (BOOLEAN_TYPES.has(itn)) return "boolean"
    if (NUMBER_TYPES.has(itn)) return "number"
    if (BIG_TYPES.has(itn) || STRING_TYPES.has(itn)) return "text"
    return undefined
}

function toLiteral(type: EDataType, value: unknown): string | number | boolean | null {
    if (value === null || value === undefined) return null
    if (isEEnum(type)) {
        if (typeof value === "number") {
            const literal = type.getEEnumLiteralByValue(value)
            return literal ? literal.getLiteral() || literal.getName() : value
        }
        return String(value)
    }
    if (typeof value === "boolean" || typeof value === "number") return value
    if (typeof value === "bigint") return value.toString()
    if (value instanceof Date) return value.toISOString()
    try {
        return EcoreUtils.convertToString(type, value)
    } catch {
        return String(value)
    }
}

function fromLiteral(type: EDataType, literal: string): unknown {
    if (isEEnum(type)) {
        const l = type.getEEnumLiteralByLiteral(literal) ?? type.getEEnumLiteralByName(literal)
        if (!l) throw new Error(`'${literal}' is not a literal of ${type.getName()}`)
        return l.getValue()
    }
    const itn = instanceType(type)
    if (BOOLEAN_TYPES.has(itn)) return literal.trim().toLowerCase() === "true"
    if (NUMBER_TYPES.has(itn)) {
        const n = Number(literal)
        if (Number.isNaN(n)) throw new Error(`'${literal}' is not a number`)
        return n
    }
    return EcoreUtils.createFromString(type, literal)
}

function collectDiagnostics(resource: EResource): ModelDiagnostic[] {
    // the XML decoder reports 0-based sax positions; diagnostics are 1-based like the fatal ones
    const result: ModelDiagnostic[] = []
    for (const e of resource.getErrors()) {
        if (isXmlSyntaxError(e.message)) continue // reported as the fatal diagnostic
        result.push({ message: e.message, line: (e.line ?? 0) + 1, column: (e.column ?? 0) + 1, severity: "error" })
    }
    for (const w of resource.getWarnings()) result.push({ message: w.message, line: (w.line ?? 0) + 1, column: (w.column ?? 0) + 1, severity: "warning" })
    return result
}

/** sax reports its syntax errors as "message\nLine: N\nColumn: M\nChar: c" */
function isXmlSyntaxError(message: string): boolean {
    return /\nLine:\s*\d+/.test(message)
}

function toFatalDiagnostic(message: string): ModelDiagnostic {
    // sax reports "message\nLine: N\nColumn: M\nChar: c"
    const line = /Line:\s*(\d+)/.exec(message)
    const column = /Column:\s*(\d+)/.exec(message)
    return {
        message: message.split("\n")[0],
        line: line ? Number(line[1]) + 1 : 1,
        column: column ? Number(column[1]) + 1 : 1,
        severity: "error"
    }
}
