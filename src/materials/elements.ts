/** Chemical element SYMBOLS (nomenclature only, in the order of atomic number 1..118) - the one closed vocabulary the composition validators need.
 *
 *  Verified against the NIST "Atomic Weights and Isotopic Compositions for All Elements" listing (physics.nist.gov/cgi-bin/Compositions/stand_alone.pl): 118 elements,
 *  H ... Og. NO atomic weight, atomic number or any other element property is stored here: converting mass fractions to atomic fractions needs verified atomic weights
 *  and is therefore not implemented (see README). */

export const ELEMENT_SYMBOLS: readonly string[] = Object.freeze([
  'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg',
  'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr',
  'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr',
  'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd',
  'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd',
  'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf',
  'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po',
  'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm',
  'Bk', 'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr', 'Rf', 'Db', 'Sg', 'Bh', 'Hs',
  'Mt', 'Ds', 'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og',
]);

const ELEMENT_SET: ReadonlySet<string> = new Set(ELEMENT_SYMBOLS);

export function isElementSymbol(value: unknown): value is string {
  return typeof value === 'string' && ELEMENT_SET.has(value);
}
