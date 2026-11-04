---
name: nhtsa-vehicle-safety-guide
description: Gates and identifier chains for the nhtsa_* tools (recalls, owner complaints, NCAP crash ratings, defect investigations, VIN decodes). Covers the several model names NHTSA files one vehicle under, merging results without double counting, make versus manufacturer, model year versus received date, campaign number forms, and what an empty or Not Rated result proves. Use for any vehicle, child seat, or tire safety question.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

U.S. NHTSA data, keyless: recall campaigns for vehicles, equipment, tires, and child seats; owner complaints; NCAP crash ratings; defect investigations by NHTSA's Office of Defects Investigation (ODI); VIN decoding.

- A **recall** is a campaign with a remedy, keyed by campaign number. An **investigation** is NHTSA's own defect inquiry (Preliminary Evaluation, Engineering Analysis, and other types) and lists the recalls it led to. A **complaint** is one owner's report, keyed by its ODI number.
- Recall searches find child seats and tires by brand: run a broad recall search with the brand as the make (`Graco`, `Bridgestone`).
- Not here: whether one VIN is in a campaign or still unrepaired (no tool takes a VIN for recalls), crash-fatality statistics, IIHS or non-U.S. ratings, vehicle history.

## Identifiers

| Identifier | Looks like | Comes from | Feeds |
|:--|:--|:--|:--|
| Campaign number | `24V744000`; the letter after the first two digits is the type: `V` vehicle, `E` equipment, `T` tire, `C` child seat; a few campaigns carry `I` or `X` | recall results; an investigation's `recallCampaigns` | nhtsa_search_recalls, campaign lookup |
| Investigation ID | type prefix plus a number, `EA23003`; some older IDs hold a letter, `EA78N34` | investigation rows; the `investigationId` of a campaign lookup | nhtsa_search_investigations, ID lookup |
| NCAP `vehicleId` | a number per tested variant | nhtsa_get_vehicle_safety, nhtsa_get_safety_ratings | nhtsa_get_safety_ratings |
| ODI number | complaint `odiNumber` | complaint rows | the key for merging complaints |
| Dataset model name | uppercase, tagged `products`, `ncap`, or `vpic` | nhtsa_lookup_vehicles `dataset_models` | complaint, rating, and recall searches |

Campaign numbers come in two forms:

- Investigations list each campaign in the 9-character form or a 6-character one (`24V744`). Pass either exactly as listed: a 6-character number returns every campaign it covers (`00V419` → `00V419001` and `00V419002`), each with its own detail. Never append `000` yourself: `00V419000` matches nothing.
- The leading digits are not the received date: `13V544000` was received 2015-10-30. Filter dates with the date range, never by prefix.

## Gates

- **Run `dataset_models` whenever the answer must be complete, notice or not.** NHTSA files one vehicle under several names, and the notices that point to this lookup fire only when a search comes back empty. For a 2014 Chevrolet, `SILVERADO 1500` returns recalls, NCAP variants, and complaints with no notice, while a separate set of recalls sits only under the base name `SILVERADO`.
- **Pin the series before searching under it.** A base name covers several series (`SILVERADO` → `SILVERADO 1500`, `2500`, `3500`). A decoded VIN reports the VPIC name, which can lack the series: `3GCUKRECXEG100001` decodes as `Silverado`, trim `LT`. Ask which series the user has.
- **Never add complaint totals across names.** Names can return the same complaints: 2016 Tesla `MODEL S 85D` and `MODEL S P90D` each return the same 604 complaints. Merge complaints by ODI number and recalls by campaign number.
- **A recall names a model year, not a VIN.** Campaigns cover "certain" vehicles by build date (`14V246000`: 2014 Silverados manufactured May 23, 2013, through March 25, 2014). Say the model year was recalled. Never say the user's vehicle is affected or still unrepaired; that takes a VIN-level recall check, which no tool here does.
- **Make is not manufacturer.** A broad recall search matches the vehicle's make. Toyota Motor Engineering & Manufacturing files Lexus campaigns that only make `Lexus` returns, and make `Toyota` also returns a BMW-filed Supra campaign (`26V056000`) and distributors' campaigns. For one manufacturer's recalls, search each of its makes and keep rows by `manufacturer`.
- **Model year is not calendar year.** Model-year filters take the vehicle's model year; date ranges bound the calendar date NHTSA received the campaign. A model year goes on sale in the previous calendar year: `13V488000`, received 2013-10-17, recalls 2014-model-year trucks. When "2020 recalls" could mean either, ask.
- **Widen a decisive date bound by a day.** A broad search can date a campaign one day before the campaign and vehicle lookups do (`24V744000`: 2024-10-03 against 2024-10-04). When the bound decides whether a campaign counts, widen it a day and confirm the date with a campaign lookup.
- **Filter complaints by a component stem.** The filter matches inside NHTSA's component names, so `BRAKE` catches `PARKING BRAKE` and `BRAKES` misses it (2003 Honda Accord: 176 against 174). It never reads narratives: 147 of that Accord's 2,013 complaints mention brakes only in the narrative, under other components. A filtered breakdown still lists every component those complaints name; read the rows you filtered for.
- **Complaint counts are raw owner reports with no sales denominator.** Never rank vehicles by them.
- **Not Rated means no score was published, not a low score.** Before model year 2011, NCAP published per-seat stars and no overall score: the 2007 Camry and 2010 Accord read Not Rated in every overall field beside 5-star frontal driver and passenger ratings. From 2011 one variant can be Not Rated where another has stars (2011 Accord: 2-door overall Not Rated, 4-door sedan 5 stars). Don't compare pre-2011 stars with 2011-and-later stars.
- **Match the NCAP variant.** Ratings come per tested variant: the 2014 `SILVERADO 1500` has six, by cab style and drive. Report the one matching the user's vehicle, or the spread.
- **Treat a check-digit warning as a likely typo.** One mistyped character yields `errorCode` 1 ("Check Digit (9th position) does not calculate properly") while make, model, and year still decode from the VIN's pattern. Confirm the VIN before reporting on that vehicle.

## Core chain

"Is my 2014 Silverado safe?"

1. nhtsa_get_vehicle_safety with the user's make, model, and model year.
2. nhtsa_lookup_vehicles `dataset_models` for the make and model year. Pick the series that matches the user's vehicle; ask when several fit.
3. Cover both names, skipping whichever step 1 already searched: nhtsa_get_vehicle_safety under the series name (listed by `products` and `ncap`), and nhtsa_search_recalls for the vehicle under the `vpic` base name. Merge the recall lists by campaign number.
4. Report the matching NCAP variant, the merged recalls as model-year recalls, and complaint patterns by component.

## Workflows

**VINs to recalls.** Decode the VINs and set aside any with a check-digit warning. Call `dataset_models` once per make and model year, then run each recall lookup once per model name, not once per VIN. Every answer stays at model-year level.

**A manufacturer's recalls since a date.** Run a broad recall search per make with the date range, page with offset until `totalCount` is reached, keep the rows whose `manufacturer` matches, and apply the date-bound gate.

**Investigations of a vehicle.** Search investigations by make, model, and model year. The year must sit on one of the investigation's vehicle associations, so an empty result means no investigation lists that year for that make and model. Before saying a model was never investigated, drop the year to see which investigations list the model, then try neighboring model years: an investigation's `years` span every vehicle it covers, so a year listed there need not belong to this model.

**Investigation to recall and back.** A vehicle recall list carries no `investigationId`; look the campaign up by number to get it, then fetch the investigation by ID. Its `recallCampaigns` go back to campaign lookups as listed.
