import express from "express";

const billingRouter = express.Router();

// Mock data for billing profiles
const mockBillingProfile = {
  id: "billing-profile-1",
  profileType: "Individual",
  annualRewardLimit: 10000.0,
  usedAmount: 5000.0,
  remainingAmount: 5000.0,
  currency: "USD",
  generalInformation: {
    firstName: "John",
    lastName: "Doe",
    email: "john.doe@example.com",
    phone: "+1 (555) 123-4567",
    address: {
      street: "123 Main Street",
      city: "San Francisco",
      state: "CA",
      zipCode: "94102",
      country: "United States",
    },
    // Flattened address fields for easier form binding
    street: "123 Main Street",
    city: "San Francisco",
    state: "CA",
    zipCode: "94102",
    country: "United States",
    taxId: "12-3456789",
    taxResidency: "United States",
    dateOfBirth: "1990-01-15",
    companyName: null,
    vatNumber: null,
    businessType: "Individual",
    occupation: "Software Developer",
    website: "https://johndoe.dev",
    notes: "Preferred contact method: Email",
  },
  paymentMethods: [
    {
      id: "pm-1",
      type: "bank_account",
      bankName: "Chase Bank",
      accountNumber: "****1234",
      routingNumber: "****5678",
      isDefault: true,
      addedDate: "2024-01-15",
    },
    {
      id: "pm-2",
      type: "paypal",
      email: "john.doe@example.com",
      isDefault: false,
      addedDate: "2024-02-20",
    },
  ],
  invoices: [
    {
      id: "inv-001",
      invoiceNumber: "INV-2024-001",
      date: "2024-03-01",
      amount: 1500.0,
      currency: "USD",
      status: "paid",
      description: "Monthly reward payment - March 2024",
      downloadUrl: "/invoices/inv-001.pdf",
    },
    {
      id: "inv-002",
      invoiceNumber: "INV-2024-002",
      date: "2024-02-01",
      amount: 2000.0,
      currency: "USD",
      status: "paid",
      description: "Monthly reward payment - February 2024",
      downloadUrl: "/invoices/inv-002.pdf",
    },
    {
      id: "inv-003",
      invoiceNumber: "INV-2024-003",
      date: "2024-01-01",
      amount: 1500.0,
      currency: "USD",
      status: "paid",
      description: "Monthly reward payment - January 2024",
      downloadUrl: "/invoices/inv-003.pdf",
    },
  ],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-03-15T10:30:00Z",
};

// GET /api/v1/billing/profile/:profileId
billingRouter.get("/billing/profile/:profileId", async (req, res) => {
  try {
    const { profileId } = req.params;
    console.log(`[billing] Fetching full profile for: ${profileId}`);
    
    // Return mock data for any profile ID with generalInformation included
    const profileData = {
      ...mockBillingProfile,
      id: profileId,
      generalInformation: {
        ...mockBillingProfile.generalInformation,
        fullAddress: `${mockBillingProfile.generalInformation.street}, ${mockBillingProfile.generalInformation.city}, ${mockBillingProfile.generalInformation.state} ${mockBillingProfile.generalInformation.zipCode}`,
      },
    };
    
    console.log(`[billing] Returning full profile data`);
    
    res.json({
      success: true,
      data: profileData,
    });
  } catch (error: any) {
    console.error("[billing] Error fetching billing profile:", error);
    res.status(500).json({
      error: "Failed to fetch billing profile",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// GET /api/v1/billing/profile/:profileId/general-information
billingRouter.get("/billing/profile/:profileId/general-information", async (req, res) => {
  try {
    const { profileId } = req.params;
    console.log(`[billing] Fetching general information for profile: ${profileId}`);
    
    // Return comprehensive general information with both nested and flattened structure
    const info = mockBillingProfile.generalInformation;
    const generalInfo = {
      profileId,
      ...info,
      // Ensure address is available both as nested object and flat fields
      fullAddress: `${info.street}, ${info.city}, ${info.state} ${info.zipCode}`,
    };
    
    console.log(`[billing] Returning general information:`, JSON.stringify(generalInfo, null, 2));
    
    res.json({
      success: true,
      data: generalInfo,
    });
  } catch (error: any) {
    console.error("[billing] Error fetching general information:", error);
    res.status(500).json({
      error: "Failed to fetch general information",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// GET /api/v1/billing-profiles/:profileId/general-information (matches frontend route pattern)
billingRouter.get("/billing-profiles/:profileId/general-information", async (req, res) => {
  try {
    const { profileId } = req.params;
    console.log(`[billing] Fetching general information (billing-profiles route) for profile: ${profileId}`);
    
    const info = mockBillingProfile.generalInformation;
    const generalInfo = {
      profileId,
      ...info,
      fullAddress: `${info.street}, ${info.city}, ${info.state} ${info.zipCode}`,
    };
    
    console.log(`[billing] Returning general information:`, JSON.stringify(generalInfo, null, 2));
    
    res.json({
      success: true,
      data: generalInfo,
    });
  } catch (error: any) {
    console.error("[billing] Error fetching general information:", error);
    res.status(500).json({
      error: "Failed to fetch general information",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// GET /api/v1/settings/billing-profiles/:profileId/general-information (matches exact frontend route)
billingRouter.get("/settings/billing-profiles/:profileId/general-information", async (req, res) => {
  try {
    const { profileId } = req.params;
    console.log(`[billing] Fetching general information (settings/billing-profiles route) for profile: ${profileId}`);
    
    const info = mockBillingProfile.generalInformation;
    const generalInfo = {
      profileId,
      ...info,
      fullAddress: `${info.street}, ${info.city}, ${info.state} ${info.zipCode}`,
    };
    
    console.log(`[billing] Returning general information:`, JSON.stringify(generalInfo, null, 2));
    
    res.json({
      success: true,
      data: generalInfo,
    });
  } catch (error: any) {
    console.error("[billing] Error fetching general information:", error);
    res.status(500).json({
      error: "Failed to fetch general information",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Direct response endpoint (no wrapper) - in case frontend expects direct data
billingRouter.get("/settings/billing-profiles/:profileId/general-information/direct", async (req, res) => {
  try {
    const { profileId } = req.params;
    console.log(`[billing] Fetching general information (direct response) for profile: ${profileId}`);
    
    const info = mockBillingProfile.generalInformation;
    
    // Return data directly without success/data wrapper
    res.json({
      profileId,
      ...info,
      fullAddress: `${info.street}, ${info.city}, ${info.state} ${info.zipCode}`,
    });
  } catch (error: any) {
    console.error("[billing] Error fetching general information:", error);
    res.status(500).json({
      error: "Failed to fetch general information",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Alternative endpoint: GET /api/v1/billing/profiles/:profileId/general-information (plural)
billingRouter.get("/billing/profiles/:profileId/general-information", async (req, res) => {
  try {
    const { profileId } = req.params;
    console.log(`[billing] Fetching general information (plural route) for profile: ${profileId}`);
    
    const info = mockBillingProfile.generalInformation;
    const generalInfo = {
      profileId,
      ...info,
      fullAddress: `${info.street}, ${info.city}, ${info.state} ${info.zipCode}`,
    };
    
    res.json({
      success: true,
      data: generalInfo,
    });
  } catch (error: any) {
    console.error("[billing] Error fetching general information:", error);
    res.status(500).json({
      error: "Failed to fetch general information",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Direct endpoint without nested structure - just return the data directly
billingRouter.get("/billing/profile/:profileId/general-information/direct", async (req, res) => {
  try {
    const { profileId } = req.params;
    const info = mockBillingProfile.generalInformation;
    
    // Return data directly without wrapping in success/data structure
    res.json({
      profileId,
      ...info,
      fullAddress: `${info.street}, ${info.city}, ${info.state} ${info.zipCode}`,
    });
  } catch (error: any) {
    console.error("[billing] Error fetching general information:", error);
    res.status(500).json({
      error: "Failed to fetch general information",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// GET /api/v1/billing/profile/:profileId/payment-methods
billingRouter.get("/billing/profile/:profileId/payment-methods", async (req, res) => {
  try {
    const { profileId } = req.params;
    
    res.json({
      success: true,
      data: {
        profileId,
        paymentMethods: mockBillingProfile.paymentMethods,
      },
    });
  } catch (error: any) {
    console.error("[billing] Error fetching payment methods:", error);
    res.status(500).json({
      error: "Failed to fetch payment methods",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// GET /api/v1/billing/profile/:profileId/invoices
billingRouter.get("/billing/profile/:profileId/invoices", async (req, res) => {
  try {
    const { profileId } = req.params;
    
    res.json({
      success: true,
      data: {
        profileId,
        invoices: mockBillingProfile.invoices,
      },
    });
  } catch (error: any) {
    console.error("[billing] Error fetching invoices:", error);
    res.status(500).json({
      error: "Failed to fetch invoices",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// GET /api/v1/billing/profile/:profileId/summary
billingRouter.get("/billing/profile/:profileId/summary", async (req, res) => {
  try {
    const { profileId } = req.params;
    
    res.json({
      success: true,
      data: {
        profileId,
        profileType: mockBillingProfile.profileType,
        annualRewardLimit: mockBillingProfile.annualRewardLimit,
        usedAmount: mockBillingProfile.usedAmount,
        remainingAmount: mockBillingProfile.remainingAmount,
        currency: mockBillingProfile.currency,
        progressPercentage: (mockBillingProfile.usedAmount / mockBillingProfile.annualRewardLimit) * 100,
      },
    });
  } catch (error: any) {
    console.error("[billing] Error fetching billing summary:", error);
    res.status(500).json({
      error: "Failed to fetch billing summary",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

export { billingRouter };

