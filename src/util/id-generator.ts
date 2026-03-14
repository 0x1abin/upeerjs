import { nanoid } from "nanoid";

export function generatePeerId(size: number = 21): string {
	return nanoid(size);
}
