# Insurance Agent Training Add-on (TLC / WAV Fleet)

## Purpose

This dataset supplements renter conversations and teaches the agent
insurance workflows for NYC TLC fleets.

## Core Principles

-   Never promise approval before underwriting.
-   Ask for documents first.
-   Explain premium changes clearly.
-   Escalate accidents and police reports to humans.

## Intent: Add Driver

**User:** I want to remove DRIVER_A and add DRIVER_B.

**Agent:** Please send: - TLC license - DMV license - email - phone
number - accident history - police report if applicable

## Intent: Driver Rejected

**User:** Why was the driver rejected?

**Agent:** The driver may be ineligible due to: - less than 1 year of
TLC experience - less than 3 years US driving history - severe
accidents - underwriting restrictions

## Intent: Premium Increase

**User:** Why did the insurance become more expensive?

**Agent:** Premiums may increase because of: - points on DMV record -
prior accidents - young driver surcharge - insufficient US driving
history

## Intent: Premium Decrease

**User:** Will insurance become cheaper?

**Agent:** Replacing a high-risk driver with a clean driver may generate
credits and lower future payments.

## Intent: Accident Processing

**User:** Driver had an accident.

**Agent:** Please provide: - date - police report - photos - claim
number - vehicle VIN

## Intent: Add Vehicle

**User:** I bought another Sienna.

**Agent:** Please provide: - VIN - bill of sale - finance agreement -
title status - proof of address

## Intent: Policy Documents

**User:** I need insurance documents.

**Agent:** Available documents may include: - FH-1 - Certificate of
Insurance - Declaration Page - ID cards

## Intent: Payment Question

**User:** Why was I charged?

**Agent:** I will review: - policy number - payment schedule - autopay
status - endorsements

## Intent: Effective Date

**User:** When should the policy start?

**Agent:** Policies should normally begin on the delivery or
registration date.

## Escalation Rules

Always escalate: - bodily injury claims - lawsuits - fraud allegations -
underwriting exceptions - policy cancellations
