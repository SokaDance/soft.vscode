import { URI } from "@masagroup/ecore"
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import type { PropertyDescriptor, Ref, TreeNode } from "../src/shared/protocol"
import { EcoreModel, readablePath, registeredPackage, relativePath, serializePackage } from "../src/extension/model/ecoreModel"
import { featureLabel } from "../src/extension/model/labels"

const LIBRARY = readFileSync(new URL("../samples/library.ecore", import.meta.url), "utf8")

const SIMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<ecore:EPackage xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:ecore="http://www.eclipse.org/emf/2002/Ecore" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="shop" nsURI="http://shop" nsPrefix="shop">
  <eClassifiers xsi:type="ecore:EClass" name="Shop">
    <eStructuralFeatures xsi:type="ecore:EAttribute" name="name" eType="ecore:EDataType http://www.eclipse.org/emf/2002/Ecore#//EString"/>
    <eStructuralFeatures xsi:type="ecore:EReference" name="items" upperBound="-1" eType="#//Item" containment="true"/>
  </eClassifiers>
  <eClassifiers xsi:type="ecore:EClass" name="Item">
    <eStructuralFeatures xsi:type="ecore:EAttribute" name="price" eType="ecore:EDataType http://www.eclipse.org/emf/2002/Ecore#//EInt"/>
  </eClassifiers>
  <eClassifiers xsi:type="ecore:EEnum" name="Color">
    <eLiterals name="RED"/>
    <eLiterals name="BLUE" value="1"/>
  </eClassifiers>
</ecore:EPackage>
`

function newModel(text = SIMPLE): EcoreModel {
    const model = new EcoreModel(new URI("file:///C:/tmp/shop.ecore"))
    expect(model.load(text)).toBe(true)
    return model
}

function find(nodes: TreeNode[], label: string): TreeNode {
    for (const n of nodes) {
        if (n.label === label) return n
        const found = n.children.length ? tryFind(n.children, label) : undefined
        if (found) return found
    }
    throw new Error(`node '${label}' not found`)
}

function tryFind(nodes: TreeNode[], label: string): TreeNode | undefined {
    try {
        return find(nodes, label)
    } catch {
        return undefined
    }
}

function prop(model: EcoreModel, id: string, feature: string): PropertyDescriptor {
    const p = model.properties(id)?.props.find((p) => p.feature === feature)
    if (!p) throw new Error(`property '${feature}' not found`)
    return p
}

describe("EcoreModel", () => {
    it("builds a tree snapshot with EMF-like labels", () => {
        const model = newModel()
        const snapshot = model.snapshot()
        expect(snapshot.fatal).toBeUndefined()
        expect(snapshot.diagnostics).toEqual([])
        expect(snapshot.roots).toHaveLength(1)
        const pkg = snapshot.roots[0]
        expect(pkg.eClass).toBe("EPackage")
        expect(pkg.label).toBe("shop")
        expect(pkg.detail).toBe("http://shop")
        expect(pkg.children.map((c) => c.label)).toEqual(["Shop", "Item", "Color"])
        const shop = pkg.children[0]
        expect(shop.children.map((c) => c.label)).toEqual(["name : EString", "items : Item"])
        expect(shop.children[1].detail).toBe("[0..*] containment")
        // the type name of the label links to its local declaration, or to the uri of an external one
        expect(shop.children[1].links).toEqual([{ start: "items : ".length, end: "items : Item".length, target: pkg.children[1].id }])
        expect(shop.children[0].links).toEqual([{ start: "name : ".length, end: "name : EString".length, target: "uri:http://www.eclipse.org/emf/2002/Ecore#//EString" }])
        expect(pkg.links).toBeUndefined()

        // a class links each of its super types
        const library = newModel(LIBRARY).snapshot().roots[0]
        const circulating = library.children.find((c) => c.label === "CirculatingItem -> Item, Lendable")!
        const target = (label: string) => library.children.find((c) => c.label.split(" ")[0] === label)!.id
        expect(circulating.links).toEqual([
            { start: "CirculatingItem -> ".length, end: "CirculatingItem -> Item".length, target: target("Item") },
            { start: "CirculatingItem -> Item, ".length, end: "CirculatingItem -> Item, Lendable".length, target: target("Lendable") }
        ])
        expect(model.idForFragment("//Item")).toBe(pkg.children[1].id)
        expect(model.idForFragment("//Nope")).toBeUndefined()
        expect(find(snapshot.roots, "BLUE = 1").icon).toBe("literal")
        // the transient eFactoryInstance must not show up
        expect(pkg.children.some((c) => c.eClass === "EFactory")).toBe(false)
    })

    it("offers child creation options per class", () => {
        const snapshot = newModel().snapshot()
        const pkgOptions = snapshot.childOptions["EPackage"].map((o) => `${o.feature}:${o.eClass}`)
        expect(pkgOptions).toContain("eClassifiers:EClass")
        expect(pkgOptions).toContain("eClassifiers:EEnum")
        expect(pkgOptions).toContain("eSubPackages:EPackage")
        expect(pkgOptions).not.toContain("eClassifiers:EClassifier")
        const classOptions = snapshot.childOptions["EClass"].map((o) => `${o.feature}:${o.eClass}`)
        expect(classOptions).toEqual(expect.arrayContaining(["eStructuralFeatures:EAttribute", "eStructuralFeatures:EReference", "eOperations:EOperation"]))
        expect(snapshot.rootOptions[0].eClass).toBe("EPackage")
    })

    it("describes properties with typed inputs and reference candidates", () => {
        const model = newModel()
        const snapshot = model.snapshot()
        const items = find(snapshot.roots, "items : Item")
        const props = model.properties(items.id)!
        expect(props.eClass).toBe("EReference")
        expect(props.props[0].feature).toBe("name")
        expect(props.props[0].value).toBe("items")
        const containment = prop(model, items.id, "containment")
        expect(containment.input).toBe("boolean")
        expect(containment.value).toBe(true)
        const upper = prop(model, items.id, "upperBound")
        expect(upper.input).toBe("number")
        expect(upper.value).toBe(-1)
        const eType = prop(model, items.id, "eType")
        expect(eType.input).toBe("reference")
        expect((eType.value as Ref).label).toBe("Item")
        // references are typed by classes only: local classes first, then Ecore ones
        const labels = eType.candidates!.map((c) => c.label)
        expect(labels.slice(0, 2)).toEqual(["Shop", "Item"])
        expect(labels).toContain("EObject (Ecore)")
        expect(labels).not.toContain("EString (Ecore)")
        // attributes are typed by data types
        const name = find(snapshot.roots, "name : EString")
        const nameType = prop(model, name.id, "eType")
        expect((nameType.value as Ref).label).toBe("EString (Ecore)")
        expect(nameType.candidates!.map((c) => c.label)).toContain("Color")
        expect(nameType.candidates!.map((c) => c.label)).not.toContain("Shop")
        // unsupported attribute types (EJavaClass) are hidden, derived ones too
        const shop = find(snapshot.roots, "Shop")
        const features = model.properties(shop.id)!.props.map((p) => p.feature)
        expect(features).not.toContain("instanceClass")
        expect(features).not.toContain("eAllAttributes")
        expect(features).toContain("abstract")
        expect(features).toContain("eSuperTypes")
    })

    it("applies attribute edits and serializes them back to XMI", () => {
        const model = newModel()
        const shop = find(model.snapshot().roots, "Shop")
        model.apply({ type: "set", id: shop.id, feature: "name", value: "Store" })
        model.apply({ type: "set", id: shop.id, feature: "abstract", value: "true" })
        const text = model.serialize()
        expect(text).toContain('name="Store"')
        expect(text).toContain('abstract="true"')
        expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
        // unsetting restores the default
        model.apply({ type: "set", id: shop.id, feature: "abstract", value: null })
        expect(model.serialize()).not.toContain('abstract="true"')
        expect(() => model.apply({ type: "set", id: shop.id, feature: "abstract", value: "maybe" })).not.toThrow()
        expect(() => model.apply({ type: "set", id: shop.id, feature: "nope", value: "x" })).toThrow(/Unknown feature/)
    })

    it("sets single and many references, including Ecore data types by URI", () => {
        const model = newModel()
        const roots = model.snapshot().roots
        const shop = find(roots, "Shop")
        const item = find(roots, "Item")
        const price = find(roots, "price : EInt")
        model.apply({ type: "setRefs", id: item.id, feature: "eSuperTypes", targets: [shop.id] })
        model.apply({ type: "setRef", id: price.id, feature: "eType", target: "uri:http://www.eclipse.org/emf/2002/Ecore#//EDouble" })
        const text = model.serialize()
        expect(text).toContain('eSuperTypes="#//Shop"')
        expect(text).toContain("Ecore#//EDouble")
        expect(find(model.snapshot().roots, "Item -> Shop")).toBeDefined()
        model.apply({ type: "setRef", id: price.id, feature: "eType", target: null })
        expect(prop(model, price.id, "eType").value).toBeNull()
    })

    it("creates, names, moves and deletes objects", () => {
        const model = newModel()
        const pkg = model.snapshot().roots[0]
        const ecore = "http://www.eclipse.org/emf/2002/Ecore"
        const created = model.apply({ type: "create", parentId: pkg.id, feature: "eClassifiers", nsURI: ecore, eClass: "EClass" }).selectId!
        const created2 = model.apply({ type: "create", parentId: pkg.id, feature: "eClassifiers", nsURI: ecore, eClass: "EClass" }).selectId!
        expect(prop(model, created, "name").value).toBe("NewClass")
        expect(prop(model, created2, "name").value).toBe("NewClass1")
        const attr = model.apply({ type: "create", parentId: created, feature: "eStructuralFeatures", nsURI: ecore, eClass: "EAttribute" }).selectId!
        expect(prop(model, attr, "name").value).toBe("newAttribute")
        // insert at an index
        const first = model.apply({ type: "create", parentId: pkg.id, feature: "eClassifiers", nsURI: ecore, eClass: "EDataType", index: 0 }).selectId!
        let labels = model.snapshot().roots[0].children.map((c) => c.eClass)
        expect(labels[0]).toBe("EDataType")
        expect(model.getParentId(first)).toBe(pkg.id)
        // move
        model.apply({ type: "move", id: first, delta: 2 })
        labels = model.snapshot().roots[0].children.map((c) => c.eClass)
        expect(labels.indexOf("EDataType")).toBe(2)
        model.apply({ type: "move", id: first, delta: -10 })
        expect(model.snapshot().roots[0].children[0].eClass).toBe("EDataType")
        // delete cleans dangling references
        const roots = model.snapshot().roots
        const items = find(roots, "items : Item")
        const item = find(roots, "Item")
        const result = model.apply({ type: "delete", id: item.id })
        expect(result.selectId).toBe(pkg.id)
        expect(prop(model, items.id, "eType").value).toBeNull()
        expect(model.serialize()).not.toContain('name="Item"')
        expect(model.serialize()).not.toContain("#//Item")
        expect(() => model.properties(item.id)).not.toThrow()
        expect(model.properties(item.id)).toBeNull()
        // abstract classes cannot be instantiated
        expect(() => model.apply({ type: "create", parentId: pkg.id, feature: "eClassifiers", nsURI: ecore, eClass: "EClassifier" })).toThrow(/abstract/)
    })

    it("creates a root package in an empty document", () => {
        const model = new EcoreModel(new URI("file:///C:/tmp/empty.ecore"))
        expect(model.load("")).toBe(true)
        expect(model.isEmpty()).toBe(true)
        const id = model.apply({ type: "create", parentId: null, nsURI: "http://www.eclipse.org/emf/2002/Ecore", eClass: "EPackage" }).selectId!
        expect(model.snapshot().roots[0].id).toBe(id)
        expect(model.serialize()).toContain('<ecore:EPackage xmi:version="2.0"')
    })

    it("keeps object ids stable across reloads", () => {
        const model = newModel()
        const before = find(model.snapshot().roots, "Item")
        model.apply({ type: "set", id: before.id, feature: "abstract", value: "true" })
        const text = model.serialize()
        expect(model.load(text)).toBe(true)
        const after = find(model.snapshot().roots, "Item")
        expect(after.id).toBe(before.id)
        expect(after.detail).toBe("abstract")
    })

    it("reports malformed XML as a fatal diagnostic and keeps the last good model", () => {
        const model = newModel()
        expect(model.load(SIMPLE.replace('name="Item"', "name=Item"))).toBe(false)
        const fatal = model.getFatal()!
        expect(fatal.severity).toBe("error")
        expect(fatal.line).toBeGreaterThan(1)
        expect(model.isReadOnly()).toBe(true)
        // last good model is still there
        expect(tryFind(model.snapshot().roots, "Item")).toBeDefined()
        // and recovers once the text is fixed
        expect(model.load(SIMPLE)).toBe(true)
        expect(model.isReadOnly()).toBe(false)
    })

    it("becomes read-only when the file uses unsupported constructs", () => {
        const model = newModel()
        model.load(SIMPLE.replace("ecore:EEnum", "ecore:EThing"))
        expect(model.getFatal()).toBeUndefined()
        expect(model.getDiagnostics().length).toBeGreaterThan(0)
        expect(model.getDiagnostics()[0].message).toMatch(/EThing/)
        expect(model.isReadOnly()).toBe(true)
    })

    it("shows the Ecore package itself as a read-only model", () => {
        const pkg = registeredPackage("http://www.eclipse.org/emf/2002/Ecore")!
        expect(pkg.getName()).toBe("ecore")
        expect(registeredPackage("http://nowhere")).toBeNull()
        const text = serializePackage(pkg)
        expect(text).toContain('name="EString"')
        const model = new EcoreModel(new URI("ecorium-package:/ecore.ecore"), { readOnlyReason: "built in" })
        expect(model.load(text)).toBe(true)
        expect(model.getDiagnostics()).toEqual([])
        expect(model.isReadOnly()).toBe(true)
        expect(model.snapshot().readOnlyReason).toBe("built in")
        const eString = model.snapshot().roots[0].children.find((c) => /^EString\b/.test(c.label))!
        expect(model.idForFragment("//EString")).toBe(eString.id)
    })

    it("round-trips the complex library sample", () => {
        const model = new EcoreModel(new URI("file:///C:/tmp/library.ecore"))
        expect(model.load(LIBRARY)).toBe(true)
        expect(model.isReadOnly()).toBe(false)
        const roots = model.snapshot().roots
        expect(roots[0].label).toBe("library")
        const writer = find(roots, "Writer -> Person")
        expect(prop(model, writer.id, "eSuperTypes").value).toEqual([expect.objectContaining({ label: "Person" })])
        const annotation = find(roots, "http:///org/eclipse/emf/ecore/util/ExtendedMetaData")
        expect(annotation.children[0].eClass).toBe("EStringToStringMapEntry")
        expect(annotation.children[1].label).toBe("kind -> mixed")
        const reloaded = new EcoreModel(new URI("file:///C:/tmp/library.ecore"))
        expect(reloaded.load(model.serialize())).toBe(true)
        expect(reloaded.getDiagnostics()).toEqual([])
    })
})

describe("searchable values", () => {
    it("sends the attributes set on each node as text", () => {
        const model = newModel()
        const pkg = model.snapshot().roots[0]
        expect(pkg.values).toEqual({ name: "shop", nsURI: "http://shop", nsPrefix: "shop" })
        const color = pkg.children.find((c) => c.label === "Color")!
        const blue = color.children.find((c) => c.label.startsWith("BLUE"))!
        expect(blue.values).toEqual({ name: "BLUE", value: "1" })
        // unset attributes are left out
        const shop = pkg.children.find((c) => c.label === "Shop")!
        expect(shop.values).toEqual({ name: "Shop" })
    })
})

describe("locate", () => {
    it("finds the start tag of an element in the XMI", () => {
        const model = new EcoreModel(new URI("file:///C:/tmp/library.ecore"))
        model.load(LIBRARY)
        const at = (label: string) => {
            const node = find(model.snapshot().roots, label)
            const span = model.locate(node.id, LIBRARY)!
            const lineStart = LIBRARY.lastIndexOf("\n", span.offset) + 1
            return { tag: LIBRARY.slice(span.offset, span.offset + span.length), line: LIBRARY.slice(lineStart, LIBRARY.indexOf("\n", span.offset)) }
        }
        const root = model.snapshot().roots[0]
        expect(model.locate(root.id, LIBRARY)).toEqual({ offset: LIBRARY.indexOf("<ecore:EPackage") + 1, length: "ecore:EPackage".length })
        const book = root.children.find((c) => /^Book\b/.test(c.label))!
        const span = model.locate(book.id, LIBRARY)!
        expect(LIBRARY.slice(span.offset, span.offset + span.length)).toBe("eClassifiers")
        const title = book.children.find((c) => /^title\b/.test(c.label))!
        const titleSpan = model.locate(title.id, LIBRARY)!
        const titleLine = LIBRARY.slice(LIBRARY.lastIndexOf("\n", titleSpan.offset) + 1, LIBRARY.indexOf("\n", titleSpan.offset))
        expect(titleLine).toContain('name="title"')
        expect(at("Mystery = 0").line).toContain('name="Mystery"')
    })
})

describe("external packages", () => {
    const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
    const fixtureUri = (name: string) => pathToFileURL(fixturePath(name)).href

    it("lists the referenced packages and lets unreferenced ones be added and removed", () => {
        const text = readFileSync(fixturePath("use.ecore"), "utf8")
        const model = new EcoreModel(new URI(fixtureUri("use.ecore")))
        expect(model.load(text)).toBe(true)

        // the super type lives in types.ecore, the attribute type in Ecore itself
        let list = model.externalPackages()
        expect(list.map((p) => [p.label, p.referenced, !!p.builtin]).sort()).toEqual([
            ["ecore", true, true],
            ["types", true, false]
        ])
        const types = list.find((p) => p.label === "types")!
        expect(types.path).toBe("types.ecore")
        expect(types.fullPath.endsWith("test/fixtures/types.ecore")).toBe(true)
        expect(types.fullPath.startsWith("file:")).toBe(false)
        expect(() => model.removeExternalPackage(types.uri)).toThrow(/referenced/)

        // a package added by hand is not referenced, and its classes become candidates
        model.addExternalPackage(fixtureUri("extra.ecore"))
        list = model.externalPackages()
        const extra = list.find((p) => p.label === "extra")!
        expect(extra.referenced).toBe(false)
        const thing = model.snapshot().roots[0].children[0]
        const superTypes = model.properties(thing.id)!.props.find((d) => d.feature === "eSuperTypes")!
        expect(superTypes.candidates!.some((c) => c.label.startsWith("Extra"))).toBe(true)

        // kept when the resource set is rebuilt, gone once removed
        model.reset(text)
        expect(model.externalPackages().some((p) => p.label === "extra")).toBe(true)
        model.removeExternalPackage(extra.uri)
        expect(model.externalPackages().some((p) => p.label === "extra")).toBe(false)

        // a file that cannot be read is refused and leaves no trace
        expect(() => model.addExternalPackage(fixtureUri("missing.ecore"))).toThrow(/Cannot load/)
        expect(model.externalPackages().length).toBe(2)
    })

    it("shows paths relative to the document when possible", () => {
        expect(relativePath("D:/models/a/use.ecore", "D:/models/a/types.ecore")).toBe("types.ecore")
        expect(relativePath("D:/models/a/use.ecore", "D:/models/a/sub/types.ecore")).toBe("sub/types.ecore")
        expect(relativePath("D:/models/a/use.ecore", "D:/models/common/types.ecore")).toBe("../common/types.ecore")
        expect(relativePath("D:/models/a/use.ecore", "d:/Models/A/types.ecore")).toBe("types.ecore")
        expect(relativePath("D:/models/a/use.ecore", "E:/other/types.ecore")).toBe("E:/other/types.ecore")
        expect(relativePath("/home/me/a/use.ecore", "/home/me/b/types.ecore")).toBe("../b/types.ecore")
        expect(relativePath("D:/models/use.ecore", "http://www.eclipse.org/emf/2002/Ecore")).toBe("http://www.eclipse.org/emf/2002/Ecore")
    })

    it("shows file URIs as paths", () => {
        expect(readablePath("file:///D:/models/a%20b.ecore")).toBe("D:/models/a b.ecore")
        expect(readablePath("file:///home/me/x.ecore")).toBe("/home/me/x.ecore")
        expect(readablePath("http://www.eclipse.org/emf/2002/Ecore")).toBe("http://www.eclipse.org/emf/2002/Ecore")
    })
})

describe("featureLabel", () => {
    it("formats feature names like the EMF property sheet", () => {
        expect(featureLabel("name")).toBe("Name")
        expect(featureLabel("nsURI")).toBe("Ns URI")
        expect(featureLabel("eType")).toBe("EType")
        expect(featureLabel("eSuperTypes")).toBe("ESuper Types")
        expect(featureLabel("lowerBound")).toBe("Lower Bound")
        expect(featureLabel("instanceClassName")).toBe("Instance Class Name")
    })
})
