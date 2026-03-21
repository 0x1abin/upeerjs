export enum LogLevel {
	Disabled,
	Errors,
	Warnings,
	Info,
	Debug,
	All,
}

export class Logger {
	tag: string;
	private _logLevel: LogLevel;

	constructor(tag: string, logLevel: LogLevel = LogLevel.Warnings) {
		this.tag = `[${tag}]:`;
		this._logLevel = logLevel;
	}

	get logLevel(): LogLevel {
		return this._logLevel;
	}

	set logLevel(logLevel: LogLevel) {
		this._logLevel = logLevel;
	}

	trace(...args: unknown[]) {
		if (this._logLevel >= LogLevel.All) {
			this._print(LogLevel.All, ...args);
		}
	}

	debug(...args: unknown[]) {
		if (this._logLevel >= LogLevel.Debug) {
			this._print(LogLevel.Debug, ...args);
		}
	}

	info(...args: unknown[]) {
		if (this._logLevel >= LogLevel.Info) {
			this._print(LogLevel.Info, ...args);
		}
	}

	warn(...args: unknown[]) {
		if (this._logLevel >= LogLevel.Warnings) {
			this._print(LogLevel.Warnings, ...args);
		}
	}

	error(...args: unknown[]) {
		if (this._logLevel >= LogLevel.Errors) {
			this._print(LogLevel.Errors, ...args);
		}
	}

	private _print(logLevel: LogLevel, ...rest: unknown[]): void {
		const copy = [this.tag, ...rest];

		for (const i in copy) {
			if (copy[i] instanceof Error) {
				copy[i] = "(" + (copy[i] as Error).name + ") " + (copy[i] as Error).message;
			}
		}

		if (logLevel >= LogLevel.All) {
			console.trace(...copy);
		} else if (logLevel >= LogLevel.Debug) {
			console.log("D", ...copy);
		} else if (logLevel >= LogLevel.Info) {
			console.info("I", ...copy);
		} else if (logLevel >= LogLevel.Warnings) {
			console.warn("W", ...copy);
		} else if (logLevel >= LogLevel.Errors) {
			console.error("E", ...copy);
		}
	}
}

export function createLogger(tag: string, debug?: boolean): Logger {
	return new Logger(tag, debug ? LogLevel.Debug : LogLevel.Warnings);
}
