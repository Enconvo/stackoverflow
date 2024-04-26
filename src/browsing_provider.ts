
export interface BrowsingResult {
    raw: string;
    items: BrowsingItem[];
}

export interface BrowsingItem {
    title: string;
    url: string;
    content?: string;
    snippet?: string;
    images?: string[];
    [key: string]: any;
}

export type BrowsingOptions = {
    [key: string]: any;
};


export interface BrowsingProviderBase {

    call(query: string): Promise<BrowsingResult | null>
}

