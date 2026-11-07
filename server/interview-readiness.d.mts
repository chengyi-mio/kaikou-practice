export const minimumAnswerCharacters: number;
export function answerCharacters(text: string): number;
export function reviewReadiness(turns: {question:string;answer:string}[]): {ready:boolean;message:string};
