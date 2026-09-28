import { z } from 'zod';

export const invariantKindSchema = z.enum(['invariant', 'access', 'postcondition']);
export type InvariantKind = z.infer<typeof invariantKindSchema>;

const nonEmpty = z.string().min(1);

export const invariantSchema = z
  .object({
    id: nonEmpty,
    kind: invariantKindSchema,
    text: nonEmpty,
  })
  .strict();
export type Invariant = z.infer<typeof invariantSchema>;

export const contractSchema = z
  .object({
    path: nonEmpty.optional(),
    name: nonEmpty,
    constructorArgs: z.array(z.union([z.string(), z.number(), z.boolean()])),
    editable: z.array(nonEmpty).min(1),
  })
  .strict();

export const actorsSchema = z
  .object({
    users: z.number().int().min(1),
    owner: nonEmpty,
    attacker: z.boolean(),
  })
  .strict();

export const rehearsalSchema = z
  .object({
    normalTx: z.number().int().min(0),
    expectRevertTx: z.number().int().min(0),
  })
  .strict();

export const specSchema = z
  .object({
    specfirst: z.literal(1),
    name: nonEmpty,
    projectId: nonEmpty,
    contract: contractSchema,
    solc: z.string().regex(/^\d+\.\d+\.\d+$/, 'solc must be an exact version like 0.8.28'),
    actors: actorsSchema,
    invariants: z.array(invariantSchema).min(1),
    unverified: z.array(nonEmpty),
    rehearsal: rehearsalSchema,
  })
  .strict()
  .superRefine((spec, ctx) => {
    const seen = new Map<string, number>();
    spec.invariants.forEach((inv, index) => {
      const first = seen.get(inv.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['invariants', index, 'id'],
          message: `duplicate invariant id "${inv.id}" (first at invariants[${first}])`,
        });
      } else {
        seen.set(inv.id, index);
      }
    });
  });

export type Spec = z.infer<typeof specSchema>;
