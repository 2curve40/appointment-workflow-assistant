export type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<PartialDeep<U>>
    : T[K] extends object
      ? PartialDeep<T[K]>
      : T[K];
};
