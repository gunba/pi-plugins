import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { commandMatches, promptCommandName, type PromptCommandInfo } from "../shared/prompt-commands.ts";
import { Icon } from "./icons.tsx";

export function useCommandCompletion(text: string, commands: PromptCommandInfo[], complete: (text: string) => void) {
	const [selected, setSelected] = useState(0), [dismissed, setDismissed] = useState<string>();
	useEffect(() => { setSelected(0); }, [text]);
	const items = dismissed === text ? [] : commandMatches(commands, text);
	const choice = items[Math.min(selected, items.length - 1)];
	const usage = dismissed !== text && /\s/.test(text) ? commands.find(command => command.name === promptCommandName(text)) : undefined;
	const list = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const menu = list.current, item = menu?.querySelector<HTMLElement>("[aria-selected=true]");
		if (!menu || !item) return;
		const top = item.getBoundingClientRect().top - menu.getBoundingClientRect().top + menu.scrollTop;
		if (top < menu.scrollTop) menu.scrollTop = top;
		else if (top + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = top + item.offsetHeight - menu.clientHeight;
	}, [choice?.name, text]);
	const accept = (command: PromptCommandInfo) => complete(`/${command.name} `);
	return {
		active: items.length > 0,
		selected: choice ? `command-${choice.name}` : undefined,
		keyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
			if (!items.length || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
			if (event.key === "Escape") { event.preventDefault(); setDismissed(text); return true; }
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault(); setSelected(index => (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length); return true;
			}
			if (choice && (event.key === "Tab" || event.key === "Enter" && text !== `/${choice.name}`)) {
				event.preventDefault(); accept(choice); return true;
			}
			return false;
		},
		menu: items.length ? <div ref={list} className="command-completion" id="command-completion" role="listbox" aria-label="Pi commands">
			<div className="command-completion-heading"><Icon name="terminal" /><strong>Commands · {items.length}</strong><span>Tab to complete</span></div>
			{items.map(command => <button key={command.name} type="button" role="option" id={`command-${command.name}`}
				aria-selected={choice?.name === command.name} onMouseDown={event => event.preventDefault()} onClick={() => accept(command)}>
				<strong>/{command.name}{command.argumentHint && <span className="command-argument"> {command.argumentHint}</span>}</strong><small>{command.unavailable ? "Not bridged" : command.kind}</small><span>{command.unavailable ?? command.description}</span>
			</button>)}
		</div> : usage ? <div className="command-usage"><strong>/{usage.name} {usage.argumentHint}</strong> {usage.unavailable ?? usage.description}</div> : null,
	};
}
