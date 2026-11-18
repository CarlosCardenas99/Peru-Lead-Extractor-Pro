
export interface BusinessLead {
  id: string;
  name: string;
  rating: string;
  reviews: string;
  address: string;
  phone: string;
  mapsUrl: string;
  category: string;
  website: string;
}

export interface SearchParams {
  businessType: string;
  location: string;
  maxReviews: number;
}

export interface ScrapingState {
  isLoading: boolean;
  error: string | null;
  leads: BusinessLead[];
  currentPage: number;
  itemsPerPage: number;
}
