// Declaration shapes the type reader has to see through. Not a model: no decorators, read with readDeclaredClass() only.
export class Target {
    id!: number;
    name!: string;
}

export type TargetRef = Pick<Target, 'id'>;
export type TargetList = Target[];
export type ProjectedList = { [Key in keyof Target]: Target[Key] }[];

export class Shapes {
    static registry = new Map<string, Shapes>();

    constructor(public fromConstructor: string) {}

    id!: number;
    status!: 'open' | 'closed';
    mixed!: string | number;
    handler!: () => void;
    aliased?: TargetRef;
    mapped?: { [Key in keyof Target]: Target[Key] };
    genericArray!: Array<Target>;
    nullableArray!: Target[] | null;
    aliasedArray!: TargetList;
    projectedList!: ProjectedList;
    nullableTarget!: Target | null;

    describe(): string {
        return this.status;
    }
}
