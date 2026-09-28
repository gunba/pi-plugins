export interface FolderLocation { name: string; path: string }
export interface RecentProject { path: string; modified: number }
export interface FolderPlaces {
	locations: FolderLocation[];
	projects: FolderLocation[];
	warning?: string;
}
export interface FolderPage {
	path: string;
	parent?: string;
	breadcrumbs: FolderLocation[];
	folders: (FolderLocation & { link?: boolean })[];
	offset: number;
	total: number;
	next?: number;
}
export const FOLDER_PAGE_SIZE = 100;
