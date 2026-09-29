import type { UiQuestion } from "../../../pi-ui/index.ts";
export function providerChoices(prompt: { message: string; options: readonly { id: string; label: string; description?: string }[] }) {
	const options = prompt.options.map(option => ({
		...option, title: prompt.options.filter(other => other.label === option.label).length === 1 ? option.label : `${option.label} (${option.id})`,
	}));
	const remoteChoice = options.some(option => /device/i.test(option.id)) && options.some(option => /browser/i.test(option.id));
	if (remoteChoice) options.sort((a, b) => Number(/device/i.test(b.id)) - Number(/device/i.test(a.id)));
	const form: UiQuestion = {
		kind: "question", title: prompt.message,
		...(remoteChoice ? { context: "Device-code sign-in works from any computer or phone. Browser sign-in sends its callback to the computer running Pi; on another device you may need to paste the final redirect URL back here." } : {}),
		options: options.map(option => ({ title: option.title, description: option.description })),
		allowMultiple: false, allowFreeform: false, allowComment: false,
	};
	return { form, resolve: (title: string) => options.find(option => option.title === title)?.id };
}
