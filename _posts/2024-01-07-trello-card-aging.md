---
layout: main
title: Trello card aging
desc: Card aging via Trello and via our Power-Up
date: '2024-01-07 13:25:00 -0400'
thumb: 'https://i.imgur.com/dompdmp.png'
---
<h1>Trello card aging</h1>
<img alt="Color ranges for card labels" src="https://i.imgur.com/dompdmp.png">
We all love the famous Card Aging Power-Up by Trello. We like it because it is so simple. No need to configure anything. It just works based on the age of the card in a list. It has no options, you just measure the age in weeks.

There are cases though, when we need more control over the aging periods. For instance, it makes in case we use a Trello board for customer issues, to have finer intervals. For example, we want the card to be yellow on the first day, orange on the second day and red after 2 days as it is a customer bug and we want bugs fixed with priority.

For such cases, our Card Time In List for Trello Power-Up provides a color range property. It is easy to set-up, just go to our Power-Up menu, click Settings and then append:
```
colorranges=0-1 yellow,1-2 orange,2+ red
```
In this case, unit of measure is set to days in settings. The color ranges property works with the unit of measure property to set up the ranges. If unit of measure would have been set to hours, then the label colors would change after each our until they become red.

Want more granular control for your card aging? Give our Power-Up a try:

<a class="gtButton" href="https://trello.com/power-ups/6211e70cf500cc8f17546a80/enable">Add To Trello</a>
