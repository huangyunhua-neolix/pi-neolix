export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	// forEach is on both the DOM lib Headers and undici's Headers; entries()
	// is missing from the DOM lib's Headers interface in this TS version, so
	// using forEach keeps this working regardless of which lib resolves Headers.
	headers.forEach((value, key) => {
		result[key] = value;
	});
	return result;
}
