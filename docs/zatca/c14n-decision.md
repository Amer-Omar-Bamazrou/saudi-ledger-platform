# Canonicalisation: why we use a C14N 1.0 engine and declare `xml-c14n11`

**Decision:** use `xml-crypto`'s inclusive **C14N 1.0** engine, declaring
`http://www.w3.org/2006/12/xml-c14n11` in the signature.

**Status:** approved on evidence, M12.3. This is an accepted, tested divergence
in *implementation*, not in *behaviour* — the output is byte-identical to
ZATCA's.

## The problem

ZATCA mandates C14N 1.1. **No maintained Node XML-DSig library implements it:**

| Library | Canonicalisation available |
| --- | --- |
| `xmldsigjs` 2.8.8 | exclusive C14N only — **no inclusive canonicalizer at all** |
| `xml-crypto` 6.1.2 | exclusive C14N + **inclusive C14N 1.0** |

`xmldsigjs` was the original choice and was **disqualified** on reading its
source. The ZATCA-specific JS libraries (`zatca-xml-js` et al.) don't solve this
either — they hand-roll their own canonicalisation precisely because nothing
provides 1.1, which is *less* auditable, not more.

## Why C14N 1.0 is correct here

C14N 1.1 differs from C14N 1.0 in **exactly one** respect: the handling of
`xml:base` / `xml:id` / `xml:lang` / `xml:space` inheritance when a canonicalised
element has an **omitted ancestor**. With no omitted ancestors, they are the same
algorithm.

Three independent proofs that this condition never arises:

### 1. Structural — the divergence condition is unreachable

ZATCA's exclusions are `not(//ancestor-or-self::X)`, which removes X **and its
entire subtree**. No surviving element can have an omitted ancestor. Measured on
a document containing all three excludable elements with nested children:

```
elements before:                                              107
elements excluded (self + descendants):                        13
survivors:                                                     94
survivors with an excluded ancestor (the divergence condition):  0
```

Enforced at runtime by `assertSubtreeComplete()`.

### 2. Schema — `xml:*` cannot exist in a valid UBL invoice

**No UBL XSD imports `http://www.w3.org/XML/1998/namespace`**, so `xml:lang` /
`xml:space` / `xml:base` cannot be declared on instance elements at all. The 72
occurrences of `xml:lang` across the CCTS schemas are all inside
`<xsd:documentation xml:lang="en">` — the schema files' own metadata. UBL tags
language with **`languageID`**.

ZATCA's own signer confirms it:

```
[ERROR] failed to sign invoice [An attribute node (xml:lang) cannot be created
after a child of the containing element...]
```

Enforced at runtime by `assertNoXmlAttributes()`.

### 3. Empirical — byte-identical to ZATCA, including the divergence case

| Fixture | Ours (C14N 1.0) | ZATCA `-generateHash` | |
| --- | --- | --- | --- |
| Plain invoice | `NRhTmCMYV0J6wdcHbrDwKll5Wm7i+/lL+7gg3IXKIXk=` | same | ✅ |
| **With `xml:lang`, `xml:space`, `xml:base`, `xml:id` injected** | `/DC4QYBCuS0WMPSE7P6cdAjzbPXMbEVl5Y1cVwB8XbA=` | same | ✅ |

The second row is the important one: the engines agree **even when the
divergence case is forced**.

### The risk is inverted, not accepted

ZATCA bundles Apache Santuario **including a real `Canonicalizer11`** — they use
genuine C14N 1.1. So this is not two implementations sharing a bug; it is our
C14N 1.0 output matching a correct C14N 1.1 implementation, which is what the
equivalence predicts.

Declaring `xml-c14n11` is therefore **accurate**: on this input class we are
performing C14N 1.1, because the two algorithms coincide.

## Guards

All three are permanent, and the first two are **runtime assertions inside the
hashing path**, not fixture tests — a fixture test only catches the documents
someone thought to write.

1. **`assertNoXmlAttributes()`** — refuses to sign any document carrying an
   `xml:*` attribute. Fails loudly in production on a real invoice.
2. **`assertSubtreeComplete()`** — refuses to sign if any element survives the
   transform while an ancestor was removed. Pins the *actual* invariant rather
   than one of its consequences.
3. **SDK hash-equality test, blocking in CI** — our hash must equal
   `fatoora -generateHash` for the same document, so a change on either side
   surfaces immediately.

## If this ever needs revisiting

Either guard firing means the equivalence no longer holds and we need a genuine
C14N 1.1 implementation. At that point: implement the 1.1 delta over the
existing engine (it is only the `xml:*` inheritance rules), or bridge to a Java
Santuario process. Do **not** silently relax the guards.
