#import "@preview/curryst:0.6.0": rule, prooftree

= A Small Register Machine



= Syntax

== Values
*Runtime values*

$ v ::= n | lambda | "ptr"(q) $

A value is a word, a label or a pointer.

*Instructions*

$ I ::=& "Mov" r, op \
      |& "Load" r_"dst", r_"base", op_"idx" \
      |& "halt" $

$ N = |C| $

// TODO: add stores.

= Semantics

== Operand Evaluation

#box(stroke: black, inset: 15%, [$ R tack op arrow.b.double v $])

#align(center,
  [#prooftree(
    rule(name: [E-Lit],
      $$,
      $ R tack n arrow.b.double n $
    )
  )]
)

#align(center,
  [#prooftree(
    rule(name: [$"E-Reg"$],
      [$ R(r) = v $],
      [$ R tack r arrow.b.double v $]
    )
  )]
)

*Write Helper*

$ italic("write")(R, r, v) =
  cases(
    R & "if" r = "x0",
    R[r arrow.r v] & "otherwise",
  )
$

#pagebreak()
= Soundness

Lemma 1 - Determinism

$ square $
